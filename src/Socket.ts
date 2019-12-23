import { Message, MessageType, ResponseEntity, ChannelType, WsRequest, WsResponse } from '@app/socket-types';
import { Observable, throwError, Subject, Subscription, interval, NEVER } from 'rxjs';
import { filter, map, first, timeoutWith, takeWhile, startWith, switchMap, catchError } from 'rxjs/operators';
import { breaker } from './breaker';
import { response } from './response';
import { awaitInterval } from './awaitInterval';

export type SocketConfig = {
    url: string;
    protocols?: string | string[];
    requestTimeout?: number;
    pingTimeout?: number;
    pingInterval?: number;
    reconnectInterval?: number;
    reconnectAttempts?: number;
    serializer?: (value: Message) => string;
    deserializer?: (e: MessageEvent) => WsResponse<Message>;
};

const defaultConfig = {
    requestTimeout: Infinity,
    pingTimeout: 5000,
    pingInterval: 10000,
    reconnectInterval: 5000,
    reconnectAttempts: 10,
    deserializer: (e: MessageEvent) => JSON.parse(e.data),
    serializer: (value: any) => JSON.stringify(value)
};

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

    private response: Subject<WsResponse>;

    private error: Subject<Error>;

    private reconnectSubscription: Subscription;

    constructor(config: SocketConfig) {
        this.config = { ...defaultConfig, ...config };

        this.open = new Subject();
        this.response = new Subject();
        this.request = new Subject();
        this.error = new Subject();

        this.init();
        this.connect();
    }

    private init() {
        const { serializer } = this.config;

        this.request
            .pipe(
                breaker(this.open)
            )
            .subscribe((value: any) => {
                try {
                    this.ws.send(serializer(value));
                } catch (e) {
                    this.error.next(e);
                }
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
                this.response.next(deserializer(message));
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
        this.request.next(value);
    }

    getChannel<T>(channel: ChannelType): Observable<Message<ResponseEntity<T>>> {
        return this.response
            .pipe(
                filter(item => item.event === channel),
                map(item => item.data)
            );
    }

    getEvent<T>(code: string): Observable<T> {
        return this.getChannel<T>(ChannelType.MESSAGE)
            .pipe(
                response(item => item.code === code),
            );
    }

    getEventById<T>(id: string, channel: ChannelType = ChannelType.MESSAGE): Observable<T> {
        return this.getChannel<T>(channel)
            .pipe(
                response(item => item.headers.id === id),
                first()
            );
    }

    async query<T, D = any>(code: string, data: D = null, queryOptions?: QueryOptions): Promise<T> {
        const options = {
            channel: ChannelType.MESSAGE,
            requestTimeout: this.config.requestTimeout,
            ...queryOptions
        };

        const message = new Message(MessageType.REQUEST, code, data);

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

        return source.toPromise();
    }

    getError(): Observable<Error> {
        return this.error.asObservable();
    }

    private getPing(): Observable<boolean> {
        return awaitInterval(this.config.pingInterval, () => this.pingQuery());
    }

    private async pingQuery(): Promise<boolean> {
        try {
            await this.query('', null, {
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
