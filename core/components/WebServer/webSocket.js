const modulename = 'WebSocket';
import { authLogic } from './requestAuthenticator';
import consoleFactory from '@extras/newConsole';
const console = consoleFactory(modulename);

//Helpers
const getIP = (socket) => {
    return (
        socket
        && socket.request
        && socket.request.connection
        && socket.request.connection.remoteAddress
    ) ? socket.request.connection.remoteAddress : 'unknown';
};
const terminateSession = (socket) => {
    // NOTE: doing socket.session.auth = {}; would also erase the web auth
    try {
        socket.emit('goDashboard');
        socket.disconnect(0);
    } catch (error) { }
};


export default class WebSocket {
    constructor(io) {
        this.io = io;
        this.dataBuffer = '';
        this.rooms = {
            liveconsole: {
                permission: 'console.view',
                eventName: 'consoleData',
                outBuffer: '',
                initialData: () => globals.logger.fxserver.getRecentBuffer(),
                commands: {
                    consoleCommand: {
                        permission: 'console.write',
                        handler: (...cmdArgs) => globals.fxRunner.liveConsoleCmdHandler(...cmdArgs),
                    },
                },
            },
            serverlog: {
                permission: true, //everyone can see it
                eventName: 'logData',
                outBuffer: [],
                initialData: () => globals.logger.server.getRecentBuffer(500),
                commands: {},
            },
        };

        setInterval(this.flushBuffers.bind(this), 250);
    }


    /**
     * Handles incoming connection requests,
     * NOTE: For now the user MUST join a room, needs additional logic for 'web' room
     *
     * @param {*} socket
     * @returns nothing relevant
     */
    handleConnection(socket) {
        try {
            //Check if joining any room
            if (!socket.handshake.query.room || !Object.keys(this.rooms).includes(socket.handshake.query.room)) {
                console.verbose.warn('SocketIO', 'dropping new connection without query.room');
                socket.disconnect(0);
            }

            //Joining room
            const roomName = socket.handshake.query.room;
            const room = this.rooms[roomName];
            const logPrefix = `SocketIO:${roomName}`;

            //Checking Auth/Perms
            const { isValidAuth, isValidPerm } = authLogic(socket.session, room.permission, logPrefix);
            if (!isValidAuth || !isValidPerm) {
                console.verbose.warn(logPrefix, 'dropping new connection without auth or perm');
                //${getIP(socket)} ???
                return terminateSession(socket);
            }

            //Setting up event handlers
            Object.keys(room.commands).forEach((commandName) => {
                socket.on(commandName, (...cmdArgs) => {
                    const { isValidAuth, isValidPerm } = authLogic(socket.session, room.commands[commandName].permission, logPrefix);

                    if (!isValidAuth || !isValidPerm) {
                        console.verbose.warn(logPrefix, 'dropping existing connection due to missing auth/permission');
                        return terminateSession(socket);
                    }
                    room.commands[commandName].handler(socket.session, ...cmdArgs);
                });
            });

            //Sending initial data
            socket.join(roomName);
            socket.emit(room.eventName, room.initialData());

            //TODO: if web, join the web room

            //General events
            socket.on('disconnect', (reason) => {
                console.verbose.debug('SocketIO', `Client disconnected with reason: ${reason}`);
            });
            socket.on('error', (error) => {
                console.verbose.debug('SocketIO', `Socket error with message: ${error.message}`);
            });

            console.verbose.log('SocketIO', `Connected: ${socket.session.auth.username} from ${getIP(socket)}`);
        } catch (error) {
            console.error('SocketIO', `Error handling new connection: ${error.message}`);
            socket.disconnect();
        }
    }


    //================================================================
    /**
     * Adds data to the buffer
     * @param {string} roomName
     * @param {string} data
     */
    buffer(roomName, data) {
        const room = this.rooms[roomName];
        if (!room) throw new Error('Room not found');

        if (Array.isArray(room.outBuffer)) {
            room.outBuffer.push(data);
        } else if (typeof room.outBuffer === 'string') {
            room.outBuffer += data;
        }
    }


    //================================================================
    /**
     * Flushes the data buffers
     * NOTE: this will also send data to users that no longer have permissions anymore
     * @param {string} data
     */
    flushBuffers() {
        Object.keys(this.rooms).forEach((roomName) => {
            const room = this.rooms[roomName];
            if (!room.outBuffer.length) return;

            this.io.to(roomName).emit(room.eventName, room.outBuffer);

            if (Array.isArray(room.outBuffer)) {
                room.outBuffer = [];
            } else if (typeof room.outBuffer === 'string') {
                room.outBuffer = '';
            }
        });
    }
};
