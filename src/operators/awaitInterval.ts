import { Observable } from 'rxjs';

export const awaitInterval = <T>(interval: number, cb: () => Promise<any>) => new Observable<T>(observer => {

    let timeoutId;

    const next = async () => {
        try {
            const value = await cb();
            observer.next(value);
            timeout();
        } catch (error) {
            observer.error(error);
            observer.complete();
        }
    };

    const timeout = () => {
        timeoutId = setTimeout(() => next(), interval);
    };

    timeout();

    return () => clearTimeout(timeoutId);
});
