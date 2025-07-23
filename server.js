
/**
 * Node.js GPS Tracker Server (GT06 Protocol)
 * * This script creates a complete, single-file server to track GPS devices that use the GT06 protocol.
 * * --- FEATURES ---
 * 1.  TCP Server to listen for raw data from GPS trackers.
 * 2.  GT06 Protocol Parser to decode login, location, and heartbeat packets.
 * 3.  In-memory storage for the latest location of each tracker.
 * 4.  HTTP Server to serve a web page for viewing the trackers.
 * 5.  WebSocket Server to push live location updates to the web page.
 * 6.  A real-time map using Leaflet.js and OpenStreetMap.
 * * --- HOW TO RUN ---
 * 1.  Save this file as `server.js`.
 * 2.  Install the required 'ws' package for WebSockets:
 * npm install ws
 * 3.  Run the server from your terminal:
 * node server.js
 * 4.  Open your web browser and navigate to http://localhost:8081
 * 5.  Configure your GPS tracker to send data to your server's public IP address and port 8080.
 *
 * --- HOW TO TEST WITHOUT A REAL TRACKER ---
 * You can use a tool like 'netcat' to send the raw hex data to the server.
 * 1. Run the server.
 * 2. In a new terminal, send a login packet (replace with your tracker's IMEI):
 * echo "78780d01086802203853172400010d0a" | xxd -r -p | nc localhost 8080
 * 3. Then send a location packet (this example is for Ghorahi, Nepal):
 * echo "78782212100C1A0F2E28C802E3A15D05282564000C00010002AE2D0d0a" | xxd -r -p | nc localhost 8080
 */
const fs = require('fs');
const path = require('path');
const net = require('net');
const http = require('http');
const WebSocket = require('ws');

// --- LOGGING CONFIGURATION ---
const LOG_LEVELS = {
    ERROR: 0,
    WARN: 1,
    INFO: 2,
    DEBUG: 3
};

const LOG_LEVEL = LOG_LEVELS[process.env.LOG_LEVEL?.toUpperCase()] ?? LOG_LEVELS.DEBUG;
const LOG_FORMAT = process.env.LOG_FORMAT || 'console'; // 'console' or 'json'

class Logger {
    static log(level, component, message, metadata = {}) {
        if (LOG_LEVELS[level] > LOG_LEVEL) return;

        const timestamp = formatNPTTime(new Date());
        const logEntry = {
            timestamp,
            level,
            component,
            message,
            ...metadata
        };

        if (LOG_FORMAT === 'json') {
            console.log(JSON.stringify(logEntry));
        } else {
            const metaStr = Object.keys(metadata).length > 0 ? ` ${JSON.stringify(metadata)}` : '';
            console.log(`[${timestamp}] [${level}] [${component}] ${message}${metaStr}`);
        }
    }

    static error(component, message, metadata = {}) {
        this.log('ERROR', component, message, metadata);
    }

    static warn(component, message, metadata = {}) {
        this.log('WARN', component, message, metadata);
    }

    static info(component, message, metadata = {}) {
        this.log('INFO', component, message, metadata);
    }

    static debug(component, message, metadata = {}) {
        this.log('DEBUG', component, message, metadata);
    }
}

// --- CONFIGURATION ---
const TCP_PORT = 5000; // Port for GPS trackers
const HTTP_PORT = 8081; // Port for the web interface

// In-memory storage for tracker data
const trackers = new Map(); // Key: IMEI, Value: { lat, lon, speed, course, lastUpdate, ... }

// Message queuing system to prevent data loss
const messageQueues = new Map(); // Key: IMEI, Value: Array of pending messages
const broadcastInProgress = new Map(); // Key: IMEI, Value: boolean (true if broadcast in progress)
const unbroadcastedMessages = new Map(); // Key: IMEI, Value: count
const messageCounters = new Map(); // Key: IMEI, Value: total message count

// Helper function to generate unique message ID and queue ID
function generateMessageIds(imei) {
    const currentCount = (messageCounters.get(imei) || 0) + 1;
    messageCounters.set(imei, currentCount);
    
    const messageId = currentCount.toString().padStart(4, '0');
    const imeiSuffix = imei.slice(-4);
    const messagePrefix = `${imeiSuffix}-${messageId}`;
    
    // Generate unique queue ID (timestamp + random)
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substr(2, 4);
    const queueId = `${timestamp}-${random}`;
    
    return { messageId, messagePrefix, queueId, totalCount: currentCount };
}

// Helper function to format time in NPT format (5:30:33 PM JUN-19)
function formatNPTTime(date) {
    if (!date) return 'N/A';

    // Convert to NPT (UTC+5:45)
    const nptOffset = 5.75 * 60 * 60 * 1000; // 5 hours 45 minutes in milliseconds
    const nptDate = new Date(date.getTime() + nptOffset);

    const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN',
        'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

    const hours = nptDate.getUTCHours();
    const minutes = nptDate.getUTCMinutes().toString().padStart(2, '0');
    const seconds = nptDate.getUTCSeconds().toString().padStart(2, '0');
    const ampm = hours >= 12 ? 'PM' : 'AM';
    const displayHours = hours % 12 || 12;

    const month = months[nptDate.getUTCMonth()];
    const day = nptDate.getUTCDate().toString().padStart(2, '0');

    return `${displayHours}:${minutes}:${seconds} ${ampm} ${month}-${day}`;
}

// Helper function to create tabular timestamp display
function createTimestampTable(loggedTime, payloadTime, receivedTime) {
    const loggedNPT = formatNPTTime(loggedTime);
    const payloadNPT = formatNPTTime(payloadTime);
    const receivedNPT = formatNPTTime(receivedTime);

    return `
┌─────────────────────┬─────────────────────┬─────────────────────┐
│ Logged Time         │ Payload Time        │ Server Received     │
├─────────────────────┼─────────────────────┼─────────────────────┤
│ ${loggedNPT.padEnd(19)} │ ${payloadNPT.padEnd(19)} │ ${receivedNPT.padEnd(19)} │
└─────────────────────┴─────────────────────┴─────────────────────┘`;
}

// Helper function to generate tracker statistics
function getTrackerStats() {
    const stats = {
        totalTrackers: trackers.size,
        trackersByImei: {},
        latestDataTime: null
    };

    let latestTimestamp = 0;

    for (const [imei, data] of trackers.entries()) {
        const lastUpdateTime = data.lastUpdate ? new Date(data.lastUpdate).getTime() : 0;

        stats.trackersByImei[imei] = {
            hasLocationData: !!(data.lat && data.lon),
            lastUpdate: data.lastUpdate,
            status: data.status || 'active'
        };

        if (lastUpdateTime > latestTimestamp) {
            latestTimestamp = lastUpdateTime;
            stats.latestDataTime = data.lastUpdate;
        }
    }

    return stats;
}

// Message queue management functions
function initializeQueue(imei) {
    if (!messageQueues.has(imei)) {
        messageQueues.set(imei, []);
        broadcastInProgress.set(imei, false);
        unbroadcastedMessages.set(imei, 0);
        Logger.debug('QUEUE', 'Initialized message queue', { imei });
    }
}

function enqueueMessage(imei, trackerData) {
    initializeQueue(imei);

    // Generate message ID and queue ID
    const { messageId, messagePrefix, queueId, totalCount } = generateMessageIds(imei);
    
    // Add message ID and queue ID to tracker data
    trackerData.messageId = messageId;
    trackerData.messagePrefix = messagePrefix;
    trackerData.queueId = queueId;

    const queue = messageQueues.get(imei);
    queue.push(trackerData);

    // Update unbroadcasted count
    unbroadcastedMessages.set(imei, queue.length);

    Logger.debug('QUEUE', `Message enqueued [${messagePrefix}] [Q:${queueId}]`, {
        imei,
        messageId,
        queueId,
        queueLength: queue.length,
        unbroadcastedCount: unbroadcastedMessages.get(imei),
        totalMessageCount: totalCount
    });

    // Process queue if not already in progress
    processMessageQueue(imei);
}

async function processMessageQueue(imei) {
    // Check if broadcast is already in progress for this IMEI
    if (broadcastInProgress.get(imei)) {
        Logger.debug('QUEUE', 'Broadcast already in progress, skipping', { imei });
        return;
    }

    const queue = messageQueues.get(imei);
    if (!queue || queue.length === 0) {
        Logger.debug('QUEUE', 'Queue is empty, nothing to process', { imei });
        return;
    }

    // Mark broadcast as in progress
    broadcastInProgress.set(imei, true);

    try {
        while (queue.length > 0) {
            const trackerData = queue.shift(); // Get first message from queue

            // Update tracker state with latest data
            trackers.set(imei, trackerData);

            Logger.debug('QUEUE', 'Processing queued message', {
                imei,
                remainingInQueue: queue.length
            });

            // Broadcast the message
            await broadcastToWebClientsQueued(trackerData);

            // Update unbroadcasted count
            unbroadcastedMessages.set(imei, queue.length);
        }
    } catch (error) {
        Logger.error('QUEUE', 'Error processing message queue', {
            imei,
            error: error.message,
            stack: error.stack
        });
    } finally {
        // Mark broadcast as completed
        broadcastInProgress.set(imei, false);
        Logger.debug('QUEUE', 'Queue processing completed', { imei });
    }
}

// --- 1. TCP SERVER FOR GPS TRACKERS ---

const tcpServer = net.createServer(socket => {
    const clientAddress = `${socket.remoteAddress}:${socket.remotePort}`;
    Logger.info('TCP', 'New connection established', { clientAddress });

    socket.on('data', data => {
        try {
            Logger.debug('TCP', 'Received raw data', {
                clientAddress,
                dataLength: data.length,
                hexData: data.toString('hex')
            });

            // A tracker can send multiple packets in one chunk, so we need to handle them all.
            let offset = 0;
            while (offset < data.length) {
                const packet = parseGT06Data(data.slice(offset));
                if (!packet) {
                    Logger.warn('TCP', 'Failed to parse packet, skipping remaining data', {
                        clientAddress,
                        remainingBytes: data.length - offset
                    });
                    break;
                }

                if (packet.type === 'login') {
                    // Associate IMEI with this socket connection
                    socket.imei = packet.imei;
                    if (!trackers.has(packet.imei)) {
                        trackers.set(packet.imei, { imei: packet.imei, history: [] });
                    }
                    Logger.info('TCP', 'Tracker login successful', {
                        imei: packet.imei,
                        clientAddress,
                        isNewTracker: !trackers.has(packet.imei)
                    });

                    // Respond to the tracker to acknowledge login
                    const response = Buffer.from('787805010001d9dc0d0a', 'hex'); // Standard GT06 login response
                    socket.write(response);
                    Logger.debug('TCP', 'Login response sent', { imei: packet.imei });

                } else if (packet.type === 'location' && socket.imei) {
                    Logger.info('TCP', 'Location data received', {
                        imei: socket.imei,
                        lat: packet.lat,
                        lon: packet.lon,
                        speed: packet.speed,
                        course: packet.course,
                        satellites: packet.satellites,
                        realtimeGps: packet.realtimeGps
                    });

                    const receivedTime = new Date(); // Time when server received the data
                    const trackerData = {
                        imei: socket.imei,
                        lat: packet.lat,
                        lon: packet.lon,
                        speed: packet.speed,
                        course: packet.course,
                        datetime: packet.datetime,
                        lastUpdate: new Date().toISOString(),
                        receivedTime: receivedTime.toISOString()
                    };

                    // Enqueue message instead of direct broadcast to prevent data loss
                    enqueueMessage(socket.imei, trackerData);

                } else if (packet.type === 'heartbeat' && socket.imei) {
                    Logger.debug('TCP', 'Heartbeat received', { imei: socket.imei });
                    const response = Buffer.from('787805130001d9dc0d0a', 'hex'); // Standard GT06 heartbeat response
                    socket.write(response);
                } else if (packet.type === 'unknown') {
                    Logger.warn('TCP', 'Unknown packet type received', {
                        clientAddress,
                        imei: socket.imei,
                        protocolNumber: packet.protocol
                    });
                }

                offset += packet.length;
            }
        } catch (err) {
            Logger.error('TCP', 'Error processing data', {
                clientAddress,
                imei: socket.imei,
                error: err.message,
                stack: err.stack
            });
        }
    });

    socket.on('close', () => {
        Logger.info('TCP', 'Connection closed', {
            clientAddress,
            imei: socket.imei
        });

        if (socket.imei) {
            const trackerData = trackers.get(socket.imei);
            if (trackerData) {
                trackerData.status = 'offline';
                broadcastToWebClients(trackerData);
                Logger.info('TCP', 'Tracker marked as offline', { imei: socket.imei });
            }
        }
    });

    socket.on('error', err => {
        Logger.error('TCP', 'Socket error', {
            clientAddress,
            imei: socket.imei,
            error: err.message,
            code: err.code
        });
    });
});

function decodeImeiFromBcd(hex) {
    let imei = '';
    for (let i = 0; i < hex.length; i += 2) {
        const byte = hex.substr(i, 2);
        imei += byte[0];
        if (byte[1].toLowerCase() !== 'f') imei += byte[1];
    }
    return imei.slice(0, 15);
}
// --- 2. GT06 PROTOCOL PARSER ---

function parseGT06Data(buffer) {
    if (buffer.readUInt16BE(0) !== 0x7878) return null; // Not a GT06 packet start

    const packetLength = buffer.readUInt8(2);
    const protocolNumber = buffer.readUInt8(3);
    const packet = {
        length: packetLength + 2, // total length including start and stop bits
    };

    switch (protocolNumber) {
        case 0x01: // Login Packet
            packet.type = 'login';
            const hexData = buffer.toString('hex');
            const imeiHex = hexData.slice(9, 25);
            //const imei = BigInt("0x" + imeiHex).toString();
            packet.imei = decodeImeiFromBcd(imeiHex);
            return packet;

        case 0x12: // Location Data Packet
            packet.type = 'location';
            packet.datetime = parseDatetime(buffer.slice(4, 10));
            const gpsInfo = buffer.readUInt8(10);
            // gpsInfo: bit 7-4 is number of satellites, bit 3 is gps positioning status, bit 2-0 is length of lat/lon
            packet.satellites = gpsInfo >> 4;

            // Latitude (Big Endian, signed)
            let lat = buffer.readInt32BE(11);
            // if((buffer.readUInt8(16) & 0x08) === 0){ // Check South/North bit in course/status
            //     lat = -lat; // South
            // }
            packet.lat = lat / 1800000.0;

            // Longitude (Big Endian, signed)
            let lon = buffer.readInt32BE(15);
            //  if((buffer.readUInt8(16) & 0x04) !== 0){ // Check East/West bit
            //     lon = -lon; // West
            // }
            packet.lon = lon / 1800000.0;

            packet.speed = buffer.readUInt8(19);
            const courseStatus = buffer.readUInt16BE(20);
            packet.course = courseStatus & 0x03FF; // 10 bits for course
            packet.realtimeGps = (courseStatus & 0x2000) !== 0;

            return packet;

        case 0x13: // Heartbeat (Status) Packet
            packet.type = 'heartbeat';
            // You can parse terminal info byte (at index 4) if needed
            return packet;

        default:
            packet.type = 'unknown';
            packet.protocol = protocolNumber;
            return packet;
    }
}

function parseDatetime(buffer) {
    const year = 2000 + buffer.readUInt8(0);
    const month = buffer.readUInt8(1);
    const day = buffer.readUInt8(2);
    const hours = buffer.readUInt8(3);
    const minutes = buffer.readUInt8(4);
    const seconds = buffer.readUInt8(5);
    return new Date(Date.UTC(year, month - 1, day, hours, minutes, seconds));
}


// --- 3. HTTP AND WEBSOCKET SERVER ---

const httpServer = http.createServer((req, res) => {
    Logger.debug('HTTP', 'Request received', {
        method: req.method,
        url: req.url,
        userAgent: req.headers['user-agent']
    });

    if (req.url === '/' || req.url === '/index.html') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(getHtmlContent());
        Logger.debug('HTTP', 'Served embedded HTML content');
    } else {
        const filePath = path.join(__dirname, 'index.html');
        fs.readFile(filePath, (err, data) => {
            if (err) {
                Logger.error('HTTP', 'Failed to read index.html file', {
                    filePath,
                    error: err.message
                });
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                res.end('Internal Server Error');
                return;
            }
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(data);
            Logger.debug('HTTP', 'Served index.html file', { filePath });
        });
    }
});

const wss = new WebSocket.Server({ server: httpServer });

wss.on('connection', ws => {
    Logger.info('WebSocket', 'New web client connected');

    // Send the current state of all trackers to the newly connected client
    const initialData = Array.from(trackers.values());
    ws.send(JSON.stringify({ type: 'initial_state', data: initialData }));
    Logger.debug('WebSocket', 'Initial state sent to client', { trackerCount: initialData.length });

    ws.on('message', message => {
        try {
            const data = JSON.parse(message);
            Logger.debug('WebSocket', 'Message received from client', {
                messageType: data.type,
                hasData: !!data.data
            });

            if (data.type === 'update' || data.type == 'initial_state') {
                const loggedTime = new Date(); // Time when we're logging this
                const payloadTime = data.data.datetime ? new Date(data.data.datetime) : null; // Time from GPS payload
                const receivedTime = data.data.receivedTime ? new Date(data.data.receivedTime) : new Date(); // Time when server received the data

                // Create timestamp table for comparison
                const timestampTable = createTimestampTable(loggedTime, payloadTime, receivedTime);

                trackers.set(data.data.imei, data.data);

                // Increment unbroadcasted message count for this IMEI
                const currentCount = unbroadcastedMessages.get(data.data.imei) || 0;
                unbroadcastedMessages.set(data.data.imei, currentCount + 1);

                Logger.info('WebSocket', `Tracker data received${timestampTable}`, {
                    imei: data.data.imei,
                    unbroadcastedCount: unbroadcastedMessages.get(data.data.imei)
                });

                broadcastToWebClients(data.data);
            }
        } catch (err) {
            Logger.error('WebSocket', 'Error parsing client message', {
                error: err.message,
                rawMessage: message.toString()
            });
        }
    });

    ws.on('close', () => {
        Logger.info('WebSocket', 'Web client disconnected');
    });

    ws.on('error', err => {
        Logger.error('WebSocket', 'WebSocket connection error', {
            error: err.message,
            code: err.code
        });
    });
});

function broadcastToWebClients(data) {
    Logger.debug('WebSocket', 'Broadcasting update to clients', {
        imei: data.imei,
        clientCount: wss.clients.size,
        hasLocationData: !!(data.lat && data.lon)
    });

    const message = JSON.stringify({ type: 'update', data: data });
    let successCount = 0;
    let errorCount = 0;

    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            try {
                client.send(message);
                successCount++;
            } catch (err) {
                errorCount++;
                Logger.error('WebSocket', 'Failed to send message to client', {
                    error: err.message
                });
            }
        }
    });

    // Create timestamp table for broadcast completion logging
    const loggedTime = new Date(); // Time when we're logging this
    const payloadTime = data.datetime ? new Date(data.datetime) : null; // Time from GPS payload
    const receivedTime = data.receivedTime ? new Date(data.receivedTime) : new Date(); // Time when server received the data

    // Create timestamp table for comparison
    const timestampTable = createTimestampTable(loggedTime, payloadTime, receivedTime);

    // Get unbroadcasted count before resetting
    const unbroadcastedCount = unbroadcastedMessages.get(data.imei) || 0;

    // Reset unbroadcasted message count after successful broadcast
    if (successCount > 0) {
        unbroadcastedMessages.set(data.imei, 0);
    }

    Logger.info('WebSocket', `Broadcast completed${timestampTable}`, {
        imei: data.imei,
        unbroadcastedCount: unbroadcastedCount,
        broadcastResults: { successCount, errorCount }
    });

    if (errorCount > 0) {
        Logger.warn('WebSocket', 'Broadcast completed with errors', {
            successCount,
            errorCount
        });
    }
}

async function broadcastToWebClientsQueued(data) {
    return new Promise((resolve, reject) => {
        try {
            Logger.debug('WebSocket', 'Broadcasting queued update to clients', {
                imei: data.imei,
                clientCount: wss.clients.size,
                hasLocationData: !!(data.lat && data.lon)
            });

            const message = JSON.stringify({ type: 'update', data: data });
            let successCount = 0;
            let errorCount = 0;

            wss.clients.forEach(client => {
                if (client.readyState === WebSocket.OPEN) {
                    try {
                        client.send(message);
                        successCount++;
                    } catch (err) {
                        errorCount++;
                        Logger.error('WebSocket', 'Failed to send queued message to client', {
                            error: err.message
                        });
                    }
                }
            });

            // Create timestamp table for broadcast completion logging
            const loggedTime = new Date(); // Time when we're logging this
            const payloadTime = data.datetime ? new Date(data.datetime) : null; // Time from GPS payload
            const receivedTime = data.receivedTime ? new Date(data.receivedTime) : new Date(); // Time when server received the data

            // Create timestamp table for comparison
            const timestampTable = createTimestampTable(loggedTime, payloadTime, receivedTime);

            Logger.info('WebSocket', `Broadcast completed${timestampTable}`, {
                imei: data.imei,
                unbroadcastedCount: unbroadcastedMessages.get(data.imei) || 0,
                broadcastResults: { successCount, errorCount }
            });

            if (errorCount > 0) {
                Logger.warn('WebSocket', 'Broadcast completed with errors', {
                    successCount,
                    errorCount
                });
            }

            resolve({ successCount, errorCount });
        } catch (error) {
            Logger.error('WebSocket', 'Error in queued broadcast', {
                imei: data.imei,
                error: error.message,
                stack: error.stack
            });
            reject(error);
        }
    });
}

function getHtmlContent() {
    return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Live GPS Tracker</title>
    <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" integrity="sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=" crossorigin=""/>
    <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js" integrity="sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=" crossorigin=""></script>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; margin: 0; display: flex; flex-direction: column; height: 100vh; background-color: #f0f2f5; }
        #header { background: #fff; padding: 10px 20px; border-bottom: 1px solid #ddd; box-shadow: 0 2px 4px rgba(0,0,0,0.1); z-index: 1001; }
        #header h1 { margin: 0; font-size: 1.5em; color: #333; }
        #main-content { display: flex; flex: 1; overflow: hidden; }
        #map { width: 75%; height: 100%; }
        #sidebar { width: 25%; height: 100%; background: #fff; overflow-y: auto; box-shadow: -2px 0 5px rgba(0,0,0,0.1); padding: 15px; box-sizing: border-box; }
        #sidebar h2 { margin-top: 0; color: #444; border-bottom: 2px solid #eee; padding-bottom: 10px;}
        .tracker-info { border: 1px solid #e1e1e1; border-radius: 8px; margin-bottom: 15px; padding: 15px; background: #fafafa; transition: background-color 0.3s; }
        .tracker-info:hover { background-color: #f0f8ff; }
        .tracker-info h3 { margin: 0 0 10px 0; color: #0056b3; }
        .tracker-info p { margin: 4px 0; font-size: 0.9em; }
        .tracker-info strong { color: #555; }
        .leaflet-popup-content p { margin: 5px 0; }
    </style>
</head>
<body>
    <div id="header">
        <h1>Live GPS Tracker Dashboard</h1>
    </div>
    <div id="main-content">
        <div id="map"></div>
        <div id="sidebar">
            <h2>Trackers</h2>
            <div id="tracker-list">
                <p>Waiting for tracker data...</p>
            </div>
        </div>
    </div>
    <script>
        const map = L.map('map').setView([28.3949, 84.1240], 7); // Centered on Nepal
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            maxZoom: 19,
            attribution: '© <a href="http://www.openstreetmap.org/copyright">OpenStreetMap</a>'
        }).addTo(map);

        const trackerMarkers = new Map();

        const ws = new WebSocket('ws://' + location.hostname + ':' + ${HTTP_PORT});

        ws.onopen = () => console.log('WebSocket connection established.');
        ws.onerror = (error) => console.error('WebSocket Error:', error);
        ws.onclose = () => console.log('WebSocket connection closed.');

        ws.onmessage = (event) => {
            const message = JSON.parse(event.data);
            console.log('Received message:', message);

            if (message.type === 'initial_state') {
                updateTrackerList(message.data);
                message.data.forEach(updateMapAndList);
            } else if (message.type === 'update') {
                updateMapAndList(message.data);
            }
        };

        function updateMapAndList(trackerData) {
            updateTrackerList(trackerData);

            if (!trackerData.lat || !trackerData.lon) return;

            const { imei, lat, lon, speed, course, datetime } = trackerData;
            const popupContent = \`
                <h3>IMEI: \${imei}</h3>
                <p><strong>Latitude:</strong> \${lat.toFixed(6)}</p>
                <p><strong>Longitude:</strong> \${lon.toFixed(6)}</p>
                <p><strong>Speed:</strong> \${speed} km/h</p>
                <p><strong>Course:</strong> \${course}°</p>
                <p><strong>Timestamp:</strong> \${new Date(datetime).toLocaleString()}</p>
            \`;

            if (trackerMarkers.has(imei)) {
                const marker = trackerMarkers.get(imei);
                marker.setLatLng([lat, lon]);
                marker.getPopup().setContent(popupContent);
            } else {
                const marker = L.marker([lat, lon]).addTo(map)
                    .bindPopup(popupContent);
                trackerMarkers.set(imei, marker);
            }
             map.setView([lat, lon], 15); // Auto-pan to the latest update
        }

        function updateTrackerList(data) {
             const trackerListDiv = document.getElementById('tracker-list');
             const allTrackers = new Map();

             // If data is an array (initial state), populate the map
             if (Array.isArray(data)) {
                 data.forEach(t => allTrackers.set(t.imei, t));
             } else { // It's a single update
                 // Get existing trackers first
                 document.querySelectorAll('.tracker-info').forEach(div => {
                     const imei = div.dataset.imei;
                     const lat = div.querySelector('.lat').textContent;
                     const lon = div.querySelector('.lon').textContent;
                     allTrackers.set(imei, { imei, lat, lon }); // Simplified object
                 });
                 allTrackers.set(data.imei, data); // Add/update with new data
             }
             
             if(allTrackers.size === 0) return;
             
             trackerListDiv.innerHTML = ''; // Clear the list
             
             for (const [imei, tracker] of allTrackers.entries()) {
                  const infoDiv = document.createElement('div');
                  infoDiv.className = 'tracker-info';
                  infoDiv.dataset.imei = imei;
                  
                  let content = \`<h3>IMEI: \${imei}</h3>\`;
                  if (tracker.lat && tracker.lon) {
                     content += \`
                        <p><strong>Lat:</strong> <span class="lat">\${tracker.lat.toFixed(5)}</span></p>
                        <p><strong>Lon:</strong> <span class="lon">\${tracker.lon.toFixed(5)}</span></p>
                        <p><strong>Last Update:</strong> \${new Date(tracker.lastUpdate).toLocaleTimeString()}</p>
                     \`;
                  } else {
                     content += '<p>Logged in, waiting for location data...</p>';
                  }
                  
                  infoDiv.innerHTML = content;
                  trackerListDiv.appendChild(infoDiv);
             }
        }
    </script>
</body>
</html>
    `;
}

// --- START SERVERS ---

tcpServer.listen(TCP_PORT, () => {
    Logger.info('SERVER', 'TCP server started', { port: TCP_PORT, service: 'GPS trackers' });
});

httpServer.listen(HTTP_PORT, () => {
    Logger.info('SERVER', 'HTTP server started', { port: HTTP_PORT, url: `http://localhost:${HTTP_PORT}` });
});
