import { Injectable } from '@nestjs/common';
import { get as httpsGet } from 'node:https';

/** Au-delà, on considère qu'AWS ne répond pas : on ne bloque pas le webhook. */
const REQUEST_TIMEOUT_MS = 5000;
/** Un certificat SNS pèse ~2 Ko ; on refuse tout ce qui dépasse largement. */
const MAX_RESPONSE_BYTES = 256 * 1024;

/**
 * Client HTTPS minimal (certificat de signature SNS, confirmation
 * d'abonnement). Isolé dans un provider pour rester mockable en test.
 */
@Injectable()
export class SnsHttpClient {
  get(url: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const request = httpsGet(url, { timeout: REQUEST_TIMEOUT_MS }, (res) => {
        const status = res.statusCode ?? 0;

        if (status < 200 || status >= 300) {
          res.resume();
          reject(new Error(`HTTP ${status} sur ${url}`));
          return;
        }

        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          body += chunk;
          if (body.length > MAX_RESPONSE_BYTES) {
            res.destroy();
            reject(new Error(`Réponse trop volumineuse sur ${url}`));
          }
        });
        res.on('end', () => resolve(body));
        res.on('error', reject);
      });

      request.on('timeout', () => {
        request.destroy(new Error(`Timeout sur ${url}`));
      });
      request.on('error', reject);
    });
  }
}
