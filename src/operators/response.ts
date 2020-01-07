import { Observable, of, throwError } from 'rxjs';
import { filter, switchMap } from 'rxjs/operators';
import { Message, ResponseEntity } from '@app/socket-types';

type Filter<T> = {
    (item: Message<ResponseEntity<T>>): boolean
};

export const response = <T>(filterFn: Filter<T>) => (source: Observable<Message<ResponseEntity<T>>>) =>
    source.pipe(
        filter(filterFn),
        switchMap(item => {
            if (item && item.body) {
                return item.body.success
                    ? of(item.body.data)
                    : throwError(item.body.errors);
            }
            return throwError(['Response not valid']);
        }),
    );
