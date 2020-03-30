import { Observable } from 'rxjs';

export const breaker = <T>(trigger: Observable<boolean>) => (source: Observable<T>) => {
    return new Observable(observer => {
        let queue: Array<T> = [];
        let isOpen = true;

        const subscription = source.subscribe({
            next: next => {
                isOpen
                    ? observer.next(next)
                    : queue.push(next);
            }
        });

        trigger.subscribe({
            next: next => {
                isOpen = next;
                if (isOpen && queue.length) {
                    queue.forEach(item => observer.next(item));
                    queue = [];
                } 
            },
            complete: () => {
                observer.complete();
                subscription.unsubscribe();
            }
        });
        
        return subscription;
    });
};
