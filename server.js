const net = require('net');
function parseCoordinate(hexStr) {
    const raw = parseInt(hexStr, 16);
    return raw / 30000 / 60;
}

function parseGPS(hex, socket) {
    try {
        if (!hex.startsWith("7878")) {
            console.log("Invalid packet header");
            return;
        }

        const protocol = hex.slice(6, 8);

        if (protocol === "01") {
            const imeiHex = hex.slice(8, 24);
            const imei = BigInt("0x" + imeiHex).toString();
            console.log(`🔑 Login packet from IMEI: ${imei}`);

            const response = Buffer.from("787805010001d9dc0d0a", "hex");
            socket.write(response);
            console.log(`✅ Sent login response`);
        }

        else if (protocol === "12") {
            const year = 2000 + parseInt(hex.slice(8, 10), 16);
            const month = parseInt(hex.slice(10, 12), 16);
            const day = parseInt(hex.slice(12, 14), 16);
            const hour = parseInt(hex.slice(14, 16), 16);
            const minute = parseInt(hex.slice(16, 18), 16);
            const second = parseInt(hex.slice(18, 20), 16);
            const timestamp = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')} ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}`;

            const latHex = hex.slice(20, 28);
            const lonHex = hex.slice(28, 36);
            const lat = parseCoordinate(latHex);
            const lon = parseCoordinate(lonHex);

            const flagsByte = parseInt(hex.slice(36, 38), 16);
            const isSouth = (flagsByte & 0b10000000) !== 0;
            const isWest = (flagsByte & 0b01000000) !== 0;

            const latitude = isSouth ? -lat : lat;
            const longitude = isWest ? -lon : lon;

            console.log(`📍 GPS Data Received`);
            console.log(`  🕒 Timestamp: ${timestamp}`);
            console.log(`  📌 Latitude: ${latitude.toFixed(6)}`);
            console.log(`  📌 Longitude: ${longitude.toFixed(6)}`);
        }

        else if (protocol === "13") {
            console.log("❤️ Heartbeat packet received");
            const response = Buffer.from("787805130001d9dc0d0a", "hex");
            socket.write(response);
            console.log("✅ Sent heartbeat response");
        }

        else {
            console.log(`Unsupported protocol: ${protocol}`);
        }
    } catch (err) {
        console.error('Parsing error:', err.message);
    }
}


// Create TCP server
const server = net.createServer((socket) => {
    const remoteAddress = `${socket.remoteAddress}:${socket.remotePort}`;
    console.log(`[${remoteAddress}] Connected`);

    socket.on('data', (data) => {
        const hexData = data.toString('hex');
        console.log(`[${remoteAddress}] Raw data: ${hexData}`);
        parseGPS(hexData, socket);
    });

    socket.on('close', () => {
        console.log(`[${remoteAddress}] Disconnected`);
    });

    socket.on('error', (err) => {
        console.error(`[${remoteAddress}] Error: ${err.message}`);
    });
});

// Start server
const PORT = 5000;
server.listen(PORT, () => {
    console.log(`🚀 GPS server listening on port ${PORT}`);
});
