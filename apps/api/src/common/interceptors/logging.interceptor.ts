import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Logger,
} from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import { Request } from 'express';
import { redactSecretsInText } from '../utils/redact';

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<Request>();
    const { method, originalUrl } = req;
    const started = Date.now();

    return next.handle().pipe(
      tap({
        next: () => {
          const ms = Date.now() - started;
          this.logger.log(`${method} ${originalUrl} ${ms}ms`);
        },
        error: (err: Error) => {
          const ms = Date.now() - started;
          this.logger.warn(
            `${method} ${originalUrl} ${ms}ms — ${redactSecretsInText(err.message)}`,
          );
        },
      }),
    );
  }
}
