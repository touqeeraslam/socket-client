import { inject, multiInject, optional } from 'inversify';
import { Message, MessageType, ResponseEntity, ChannelType, WsRequest, WsResponse } from '@app/socket-types';
import { Observable, throwError, Subject, Subscription, interval, NEVER } from 'rxjs';
import { filter, map, first, timeoutWith, takeWhile, startWith, switchMap, catchError } from 'rxjs/operators';
import { breaker } from './operators/breaker';
import { response } from './operators/response';
import { awaitInterval } from './operators/awaitInterval';
import { SocketConfig, defaultConfig, DISocketConfig } from './SocketConfig';
import { ISocketInterceptor, DISocketInterceptor } from './SocketInterceptor';

type QueryOptions = {
    channel?: ChannelType;
    requestTimeout?: number;
};

export class Socket {

    static CLOSE_PIPG = 3000;

    private config: SocketConfig;

    private ws: WebSocket;

    private open: Subject<boolean>;

    private request: Subject<WsRequest>;

    private requestInput: Subject<WsRequest>;

    private response: Subject<WsResponse>;

    private responseInput: Subject<WsResponse>;

    private error: Subject<Error>;

    private reconnectSubscription: Subscription;

    private pendingRequests: Map<string, WsRequest>;

    constructor(
        @inject(DISocketConfig) config: SocketConfig,
        @multiInject(DISocketInterceptor) @optional() interceptors: ISocketInterceptor[]
    ) {
        this.config = { ...defaultConfig, ...config };

        this.open = new Subject();
        this.error = new Subject();
        this.request = new Subject<WsRequest>();
        this.response = new Subject<WsResponse>();
        this.pendingRequests = new Map();

        const { request, response } = (interceptors || []).reduceRight((next, interceptor) => {
            return interceptor.intercept({
                request: next.request,
                response: next.response,
                open: this.open,
                error: this.error,
                pendingRequests: this.pendingRequests,
                socket: this
            });
        }, { request: this.request, response: this.response });

        this.requestInput = request;
        this.responseInput = response;

        this.init();
        this.connect();
    }

    private init() {
        const { serializer } = this.config;

        this.request
            .pipe(
                breaker(this.open)
            )
            .subscribe((value: WsRequest<Message>) => {
                try {
                    this.ws.send(serializer(value));
                    this.pendingRequests.set(value.data.headers.id, value);
                } catch (e) {
                    this.error.next(e);
                }
            });

        this.response
            .subscribe(item => {
                this.pendingRequests.delete(item.data.headers.id);
            });

        this.open
            .pipe(
                switchMap(isOpen => {
                    if (isOpen) {
                        return this.getPing();
                    }
                    return NEVER;
                })
            )
            .subscribe(isPing => {
                if (!isPing) {
                    this.ws.close(Socket.CLOSE_PIPG);
                }
            });
    }

    private connect() {
        const { url, protocols, deserializer } = this.config;

        this.open.next(false);

        this.ws = new WebSocket(url, protocols);

        this.ws.onopen = () => {
            this.reconnectClean();
            this.open.next(true);
        };

        this.ws.onmessage = (message: MessageEvent) => {
            try {
                // this.responseInput.next(deserializer(message));
                var msg = deserializer(message);
                if(msg.data){
                    console.log('msg has data ?????????',msg.data)
                    if(msg.data.body['data']){
                        console.log('msg has data in body ?????????', msg.data['code'])

                    if(msg.data['code']=== "GET_BLOCKS" || msg.data['code']=="GET_DELEGATES" || msg.data['code']=="GET_TRANSACTIONS"){
                        console.log('messege sending for', msg.data['code'] );
                    this.responseInput.next(msg);
                }    
                    }
                }
            } catch (e) {
                this.error.next(e);
            }
        };

        this.ws.onerror = (event: Event) => {
            this.error.next(new Error('WebSocket error'));
        };

        this.ws.onclose = (event: CloseEvent) => {
            if (event.wasClean && event.code !== Socket.CLOSE_PIPG) {
                this.open.complete();
                this.response.complete();
                this.request.complete();
                this.error.complete();
            } else {
                this.error.next(new Error(`Socket close code: ${event.code}, reason: ${event.reason}`));
                this.open.next(false);
                this.reconnect();
            }
        };
    }

    private reconnectClean() {
        if (this.reconnectSubscription) {
            this.reconnectSubscription.unsubscribe();
            this.reconnectSubscription = undefined;
        }
    }

    private reconnect() {
        if (this.reconnectSubscription) {
            return;
        }

        this.reconnectSubscription = interval(this.config.reconnectInterval)
            .pipe(
                startWith(0),
                map((_, index) => index + 1),
                takeWhile(count => count <= this.config.reconnectAttempts && !this.isOpen)
            )
            .subscribe({
                next: count => {
                    console.log(`Socket reconnect: ${count}`);
                    this.connect();
                },
                complete: () => console.log('Socket reconnect complete'),
            });
    }

    private get isOpen(): boolean {
        return Boolean(this.ws) && this.ws.readyState === WebSocket.OPEN;
    }

    send<T>(value: WsRequest<T>) {
        this.requestInput.next(value);
    }

    getChannel<T>(channel: ChannelType): Observable<Message<ResponseEntity<T>>> {
        return this.response
            .pipe(
                filter(item => item.event === channel),
                map(item => item.data)
            );
    }

    getEvent<T>(code: string): Observable<Message<ResponseEntity<T>>> {
        return this.getChannel<T>(ChannelType.MESSAGE)
            .pipe(
                response(item => item.code === code),
            );
    }

    getEventById<T>(id: string, channel: ChannelType = ChannelType.MESSAGE): Observable<Message<ResponseEntity<T>>> {
        return this.getChannel<T>(channel)
            .pipe(
                response(item => item.headers.id === id),
                first()
            );
    }

    async sendMessage<T>(message: Message, queryOptions?: QueryOptions): Promise<Message<ResponseEntity<T>>> {
        const options = {
            channel: ChannelType.MESSAGE,
            requestTimeout: this.config.requestTimeout,
            ...queryOptions
        };

        this.send({
            event: options.channel,
            data: message,
        });

        let source = this.getEventById<T>(message.headers.id, options.channel)
            .pipe(
                catchError(error => {
                    this.error.next(error);
                    return throwError(error);
                })
            );

        if (options.requestTimeout !== Infinity) {
            source = source.pipe(
                timeoutWith(options.requestTimeout, throwError(['Request Timeout error']))
            );
        }
            debugger
        return source.toPromise();
    }

    async query<T, D = any>(code: string, data: D = null): Promise<Message<ResponseEntity<T>>> {
        console.log("on query ", data);
        
        const message = new Message(MessageType.REQUEST, code, data);
        return this.sendMessage(message);
    }

    getError(): Observable<Error> {
        return this.error.asObservable();
    }

    private getPing(): Observable<boolean> {
        return awaitInterval(this.config.pingInterval, () => this.pingQuery());
    }

    private async pingQuery(): Promise<boolean> {
        try {
            const message = new Message(MessageType.REQUEST, null, null);
            await this.sendMessage(message, {
                channel: ChannelType.PING,
                requestTimeout: this.config.pingTimeout
            });
            return true;
        } catch (e) {
            return false;
        }
    }

    close() {
        this.ws.close();
    }
}
