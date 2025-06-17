const net = require('net');

// Parses a GT06 GPS packet and logs timestamp, latitude, and longitude
function parseGPS(hex) {
    try {
        if (!hex.startsWith("7878")) {
            console.log("Invalid packet header");
            return;
        }

        const protocol = hex.slice(6, 8);
        if (protocol === "12") {
            const year = 2000 + parseInt(hex.slice(8, 10), 16);
            const month = parseInt(hex.slice(10, 12), 16);
            const day = parseInt(hex.slice(12, 14), 16);
            const hour = parseInt(hex.slice(14, 16), 16);
            const minute = parseInt(hex.slice(16, 18), 16);
            const second = parseInt(hex.slice(18, 20), 16);
            const timestamp = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')} ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}`;

            const latRaw = parseInt(hex.slice(20, 28), 16);
            const lonRaw = parseInt(hex.slice(28, 36), 16);

            const latitude = latRaw / 1800000;
            const longitude = lonRaw / 1800000;

            console.log(`📍 GPS Data Received`);
            console.log(`  🕒 Timestamp: ${timestamp}`);
            console.log(`  📌 Latitude: ${latitude.toFixed(6)}`);
            console.log(`  📌 Longitude: ${longitude.toFixed(6)}`);
        } else if (protocol === "01") {
            const imeiHex = hex.slice(8, 24);
            const imei = BigInt("0x" + imeiHex).toString();
            console.log(`🔑 Login packet from IMEI: ${imei}`);

            // Send login response
            const response = Buffer.from("787805010001d9dc0d0a", "hex");
            socket.write(response);
            console.log(`✅ Sent login response`);
        } else {
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
        parseGPS(hexData);
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
