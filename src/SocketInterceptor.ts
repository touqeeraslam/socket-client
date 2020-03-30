import { WsRequest, WsResponse } from '@app/socket-types';
import { Subject } from 'rxjs';
import { Socket } from './Socket';

export const DISocketInterceptor = Symbol.for('ISocketInterceptor');

export type SocketInterceptorInput<T = any, U = any> = {
    request: Subject<WsRequest<T>>;
    response: Subject<WsResponse<U>>;
    open: Subject<boolean>;
    error: Subject<Error>;
    pendingRequests: Map<string, WsRequest>;
    socket: Socket;
}

export type SocketInterceptorOutput<T = any, U = any> = {
    request: Subject<WsRequest<T>>;
    response: Subject<WsResponse<U>>;
}

export interface ISocketInterceptor {
    intercept(params: SocketInterceptorInput): SocketInterceptorOutput;
}
