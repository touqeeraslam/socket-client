import { Message, WsResponse, WsRequest } from '@app/socket-types';

export const DISocketConfig = Symbol.for('SocketConfig');

export type SocketConfig = {
    url: string;
    protocols?: string | string[];
    requestTimeout?: number;
    pingTimeout?: number;
    pingInterval?: number;
    reconnectInterval?: number;
    reconnectAttempts?: number;
    serializer?: (value: WsRequest<Message>) => string;
    deserializer?: (e: MessageEvent) => WsResponse<Message>;
};

export const defaultConfig = {
    requestTimeout: Infinity,
    pingTimeout: 5000,
    pingInterval: 30000,
    reconnectInterval: 5000,
    reconnectAttempts: 10,
    deserializer: (e: MessageEvent) => JSON.parse(e.data),
    serializer: (value: any) => JSON.stringify(value)
};
