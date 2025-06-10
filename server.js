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

function parseCoordinate(buffer) {
  // GT06 signed 32-bit little endian / 1,800,000 scaling
  const value = buffer.readInt32LE(0);
  return value / 1800000;
}


// Utility: convert hex bytes to decimal degrees
function convertCoordinate(raw, hemisphere) {
  const coord = parseInt(raw, 16);
  const deg = Math.floor(coord / 1000000);
  const min = (coord % 1000000) / 10000;
  let decimal = deg + min / 60;
  if (hemisphere === 'S' || hemisphere === 'W') {
    decimal = -decimal;
  }
  return decimal.toFixed(6);
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

      const dateHex = data.slice(4, 10).toString('hex');
      const year = 2000 + data[4];
      const month = data[5];
      const day = data[6];
      const hour = data[7];
      const minute = data[8];
      const second = data[9];
      const timestamp = `${year}-${month}-${day} ${hour}:${minute}:${second}`;

      const latRaw = data.slice(14, 18).toString('hex');
      const lngRaw = data.slice(10, 14).toString('hex');
      const lat = parseCoordinate(latRaw);
      const lng = parseCoordinate(lngRaw);

      console.log(`[${clientId}] Time: ${timestamp}`);
      console.log(`[${clientId}] Location: ${lat}, ${lng}`);

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
