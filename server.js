// server.js
const net = require('net');
const PORT = process.env.PORT || 5000;

const server = net.createServer(socket => {
    console.log('Client connected:', socket.remoteAddress + ':' + socket.remotePort);

    socket.on('data', data => {
        const gpsData = data.toString().trim();
        console.log('Received GPS data:', gpsData);
    });

    socket.on('end', () => {
        console.log('Client disconnected');
    });

    socket.on('error', err => {
        console.error('Socket error:', err);
    });
});

server.listen(PORT, () => {
    console.log(`TCP GPS Server listening on port ${PORT}`);
});
