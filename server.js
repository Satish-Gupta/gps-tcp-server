const net = require('net');

const PORT = 5000;

// Utility: calculate XOR checksum for GT06
function calculateChecksum(buffer) {
  let checksum = 0;
  for (let i = 2; i < buffer.length - 3; i++) {
    checksum ^= buffer[i];
  }
  return checksum;
}

// Correct coordinate conversion (signed 32-bit LE / 1800000)
function parseCoordinateLE(buffer) {
  return buffer.readInt32LE(0) / 1800000;
}

const server = net.createServer(socket => {
  const clientId = `${socket.remoteAddress}:${socket.remotePort}`;
  console.log(`Client connected: ${clientId}`);

  socket.on('data', data => {
    const hex = data.toString('hex');
    console.log(`\n[${clientId}] Raw data: ${hex}`);

    const protocol = data[3];

    // --- LOGIN PACKET ---
    if (protocol === 0x01) {
      console.log(`[${clientId}] Login packet received`);

      // Send ACK
      const serial1 = data[data.length - 4];
      const serial2 = data[data.length - 3];

      const ack = Buffer.from([
        0x78, 0x78, 0x05, 0x01, serial1, serial2
      ]);

      const checksum = calculateChecksum(ack);
      const packet = Buffer.concat([
        ack,
        Buffer.from([checksum, 0x0D, 0x0A])
      ]);

      socket.write(packet);
      console.log(`[${clientId}] Sent login ACK: ${packet.toString('hex')}`);
    }

    // --- GPS LOCATION PACKET ---
    else if (protocol === 0x12) {
      console.log(`[${clientId}] GPS data packet received`);

      // Extract timestamp
      const year = 2000 + data[4];
      const month = data[5].toString().padStart(2, '0');
      const day = data[6].toString().padStart(2, '0');
      const hour = data[7].toString().padStart(2, '0');
      const minute = data[8].toString().padStart(2, '0');
      const second = data[9].toString().padStart(2, '0');
      const timestamp = `${year}-${month}-${day} ${hour}:${minute}:${second}`;

      // Extract and decode coordinates
      const lngBytes = data.slice(14, 18); // longitude
      const latBytes = data.slice(10, 14); // latitude

      const latitude = parseCoordinateLE(latBytes);
      const longitude = parseCoordinateLE(lngBytes);

      console.log(`[${clientId}] Time: ${timestamp}`);
      console.log(`[${clientId}] Location: ${latitude.toFixed(6)}, ${longitude.toFixed(6)}`);

      // ACK for GPS
      const serial1 = data[data.length - 4];
      const serial2 = data[data.length - 3];

      const ack = Buffer.from([
        0x78, 0x78, 0x05, 0x12, serial1, serial2
      ]);

      const checksum = calculateChecksum(ack);
      const packet = Buffer.concat([
        ack,
        Buffer.from([checksum, 0x0D, 0x0A])
      ]);

      socket.write(packet);
      console.log(`[${clientId}] Sent GPS ACK: ${packet.toString('hex')}`);
    }

    else {
      console.log(`[${clientId}] Unknown protocol: 0x${protocol.toString(16)}`);
    }
  });

  socket.on('close', () => {
    console.log(`Client disconnected: ${clientId}`);
  });

  socket.on('error', err => {
    console.error(`Error from ${clientId}:`, err.message);
  });
});

server.listen(PORT, () => {
  console.log(`🚀 GPS TCP Server listening on port ${PORT}`);
});
