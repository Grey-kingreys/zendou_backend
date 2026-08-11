import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SnsMessage } from '../sns-webhook.types';

/**
 * Payloads SNS/SES réels (structures officielles AWS), conservés en `.json`
 * pour pouvoir être rejoués tels quels via curl pendant une démo.
 *
 * Chaque helper renvoie une copie fraîche : un test peut modifier le message
 * sans polluer les suivants.
 */
function load(fileName: string): SnsMessage {
  const raw = readFileSync(join(__dirname, fileName), 'utf8');
  return JSON.parse(raw) as SnsMessage;
}

export const subscriptionConfirmationFixture = (): SnsMessage =>
  load('subscription-confirmation.json');

export const unsubscribeConfirmationFixture = (): SnsMessage =>
  load('unsubscribe-confirmation.json');

export const deliveryFixture = (): SnsMessage =>
  load('notification-delivery.json');

export const permanentBounceFixture = (): SnsMessage =>
  load('notification-bounce-permanent.json');

export const permanentBounceMultiFixture = (): SnsMessage =>
  load('notification-bounce-permanent-multi.json');

export const transientBounceFixture = (): SnsMessage =>
  load('notification-bounce-transient.json');

export const complaintFixture = (): SnsMessage =>
  load('notification-complaint.json');

/** `mail.messageId` porté par les fixtures Delivery / Bounce. */
export const FIXTURE_SES_MESSAGE_ID =
  '0100019250a0f3a8-7c1f4b6e-3a92-4a1f-9d0f-2b7c5e8a1d44-000000';

/** `mail.messageId` porté par la fixture Complaint. */
export const FIXTURE_COMPLAINT_SES_MESSAGE_ID =
  '0100019250b1c4d9-1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d-000000';
