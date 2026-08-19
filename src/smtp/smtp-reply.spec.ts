import { HttpException, NotFoundException } from '@nestjs/common';
import {
  SEND_REFUSAL,
  SEND_REFUSAL_REASON,
  type SendRefusalReason,
} from '../emails/emails.constants';
import {
  SEND_REFUSAL_SMTP_REPLY,
  SMTP_REPLY_ACCOUNT_SUSPENDED,
  SMTP_REPLY_AUTH_INVALID_CREDENTIALS,
  SMTP_REPLY_AUTH_REQUIRES_TLS,
  SMTP_REPLY_BODY_TOO_LARGE,
  SMTP_REPLY_DAILY_LIMIT_REACHED,
  SMTP_REPLY_DOMAIN_NOT_VERIFIED,
  SMTP_REPLY_EMAIL_NOT_VERIFIED,
  SMTP_REPLY_INSUFFICIENT_CREDITS,
  SMTP_REPLY_MAIL_FROM_REQUIRES_AUTH,
  SMTP_REPLY_MAIL_FROM_UNREADABLE,
  SMTP_REPLY_MIME_INVALID,
  SMTP_REPLY_MISSING_BODY,
  SMTP_REPLY_RCPT_TO_UNREADABLE,
  SMTP_REPLY_SIZE_EXCEEDED,
  SMTP_REPLY_TEST_SENDER_RECIPIENT_RESTRICTED,
  SMTP_REPLY_TEST_SENDER_UNAVAILABLE,
  SMTP_REPLY_TOO_MANY_CONNECTIONS,
  SMTP_REPLY_TOO_MANY_RECIPIENTS,
  SMTP_REPLY_UNKNOWN_CLIENT_REFUSAL,
  SMTP_REPLY_UNKNOWN_SERVER_ERROR,
  smtpReplyForError,
  type SmtpReply,
} from './smtp-reply';

/**
 * Fabrique une erreur portant le même motif symbolique que celui posé par
 * `EmailsService.accept()` (`refuse()`, privée à `emails.service.ts`) — en
 * réutilisant le symbole réellement exporté, pas une reconstruction. C'est ce
 * que lit `sendRefusalReason`, et donc ce que `smtpReplyForError` doit
 * traduire.
 */
function refusalError(reason: SendRefusalReason): Error {
  const error = new Error('refus de test');

  Object.defineProperty(error, SEND_REFUSAL_REASON, {
    value: reason,
    enumerable: false,
  });

  return error;
}

/** Une réponse SMTP a un code, un statut étendu, et un texte non vide. */
function expectWellFormedReply(
  reply: SmtpReply,
  code: number,
  enhancedStatus: string,
): void {
  expect(reply.code).toBe(code);
  expect(reply.enhancedStatus).toBe(enhancedStatus);
  expect(typeof reply.message).toBe('string');
  expect(reply.message.length).toBeGreaterThan(0);
}

describe('SEND_REFUSAL_SMTP_REPLY — exhaustivité', () => {
  it('a une entrée pour chaque motif réel de SEND_REFUSAL', () => {
    const reasons = Object.values(SEND_REFUSAL) as SendRefusalReason[];

    // Preuve que le test porte bien sur quelque chose : `SEND_REFUSAL`
    // compte aujourd'hui 11 motifs (S1). S'il en gagne un nouveau sans
    // entrée dans la table, l'assertion ci-dessous échoue à l'exécution —
    // la preuve « cassant » exigée par la done-condition.
    expect(reasons.length).toBe(11);

    for (const reason of reasons) {
      expect(SEND_REFUSAL_SMTP_REPLY[reason]).toBeDefined();
    }
  });
});

describe('smtpReplyForError — motifs SEND_REFUSAL (accept())', () => {
  it.each([
    [
      'ACCOUNT_SUSPENDED',
      SEND_REFUSAL.ACCOUNT_SUSPENDED,
      SMTP_REPLY_ACCOUNT_SUSPENDED,
    ],
    [
      'EMAIL_NOT_VERIFIED',
      SEND_REFUSAL.EMAIL_NOT_VERIFIED,
      SMTP_REPLY_EMAIL_NOT_VERIFIED,
    ],
    [
      'INVALID_FROM',
      SEND_REFUSAL.INVALID_FROM,
      SMTP_REPLY_MAIL_FROM_UNREADABLE,
    ],
    ['INVALID_TO', SEND_REFUSAL.INVALID_TO, SMTP_REPLY_RCPT_TO_UNREADABLE],
    ['MISSING_BODY', SEND_REFUSAL.MISSING_BODY, SMTP_REPLY_MISSING_BODY],
    ['BODY_TOO_LARGE', SEND_REFUSAL.BODY_TOO_LARGE, SMTP_REPLY_BODY_TOO_LARGE],
    [
      'DOMAIN_NOT_VERIFIED',
      SEND_REFUSAL.DOMAIN_NOT_VERIFIED,
      SMTP_REPLY_DOMAIN_NOT_VERIFIED,
    ],
    [
      'TEST_SENDER_UNAVAILABLE',
      SEND_REFUSAL.TEST_SENDER_UNAVAILABLE,
      SMTP_REPLY_TEST_SENDER_UNAVAILABLE,
    ],
    [
      'TEST_SENDER_RECIPIENT_RESTRICTED',
      SEND_REFUSAL.TEST_SENDER_RECIPIENT_RESTRICTED,
      SMTP_REPLY_TEST_SENDER_RECIPIENT_RESTRICTED,
    ],
    [
      'INSUFFICIENT_CREDITS',
      SEND_REFUSAL.INSUFFICIENT_CREDITS,
      SMTP_REPLY_INSUFFICIENT_CREDITS,
    ],
    [
      'DAILY_LIMIT_REACHED',
      SEND_REFUSAL.DAILY_LIMIT_REACHED,
      SMTP_REPLY_DAILY_LIMIT_REACHED,
    ],
  ] as Array<[string, SendRefusalReason, SmtpReply]>)(
    'traduit %s vers sa réponse SMTP dédiée',
    (_label, reason, expected) => {
      expect(smtpReplyForError(refusalError(reason))).toBe(expected);
    },
  );
});

describe('§4.4 — une ligne du tableau par test', () => {
  it('Trop de connexions depuis cette IP (CONNECT) → 421 4.7.0', () => {
    expectWellFormedReply(SMTP_REPLY_TOO_MANY_CONNECTIONS, 421, '4.7.0');
  });

  it('AUTH tenté sans chiffrement en prod (AUTH) → 538 5.7.11', () => {
    expectWellFormedReply(SMTP_REPLY_AUTH_REQUIRES_TLS, 538, '5.7.11');
  });

  it('Identifiants inconnus / faux / révoqués (AUTH) → 535 5.7.8, message identique dans les trois cas', () => {
    expectWellFormedReply(SMTP_REPLY_AUTH_INVALID_CREDENTIALS, 535, '5.7.8');
  });

  it('MAIL FROM sans authentification (MAIL FROM) → 530 5.7.0', () => {
    expectWellFormedReply(SMTP_REPLY_MAIL_FROM_REQUIRES_AUTH, 530, '5.7.0');
  });

  it('Compte suspendu — T12 (MAIL FROM) → 550 5.7.1', () => {
    expectWellFormedReply(
      smtpReplyForError(refusalError(SEND_REFUSAL.ACCOUNT_SUSPENDED)),
      550,
      '5.7.1',
    );
  });

  it('Adresse du compte non confirmée (MAIL FROM) → 550 5.7.1', () => {
    expectWellFormedReply(
      smtpReplyForError(refusalError(SEND_REFUSAL.EMAIL_NOT_VERIFIED)),
      550,
      '5.7.1',
    );
  });

  it('MAIL FROM illisible (MAIL FROM) → 501 5.1.7', () => {
    expectWellFormedReply(SMTP_REPLY_MAIL_FROM_UNREADABLE, 501, '5.1.7');
    expect(smtpReplyForError(refusalError(SEND_REFUSAL.INVALID_FROM))).toBe(
      SMTP_REPLY_MAIL_FROM_UNREADABLE,
    );
  });

  it('SIZE= annoncé supérieur au plafond (MAIL FROM) → 552 5.3.4', () => {
    expectWellFormedReply(SMTP_REPLY_SIZE_EXCEEDED, 552, '5.3.4');
  });

  it('Crédits épuisés (MAIL FROM) → 450 4.7.0, temporaire', () => {
    expectWellFormedReply(
      smtpReplyForError(refusalError(SEND_REFUSAL.INSUFFICIENT_CREDITS)),
      450,
      '4.7.0',
    );
  });

  it('Quota journalier atteint (MAIL FROM) → 451 4.7.0, temporaire', () => {
    expectWellFormedReply(
      smtpReplyForError(refusalError(SEND_REFUSAL.DAILY_LIMIT_REACHED)),
      451,
      '4.7.0',
    );
  });

  it('RCPT TO illisible (RCPT TO) → 501 5.1.3', () => {
    expectWellFormedReply(SMTP_REPLY_RCPT_TO_UNREADABLE, 501, '5.1.3');
    expect(smtpReplyForError(refusalError(SEND_REFUSAL.INVALID_TO))).toBe(
      SMTP_REPLY_RCPT_TO_UNREADABLE,
    );
  });

  it('Trop de destinataires (RCPT TO) → 452 4.5.3', () => {
    expectWellFormedReply(SMTP_REPLY_TOO_MANY_RECIPIENTS, 452, '4.5.3');
  });

  it('Message supérieur au plafond, constaté pendant DATA → 552 5.3.4 (même constante que SIZE=)', () => {
    expect(SMTP_REPLY_SIZE_EXCEEDED.code).toBe(552);
    expect(SMTP_REPLY_SIZE_EXCEEDED.enhancedStatus).toBe('5.3.4');
  });

  it('MIME illisible / plusieurs From: (fin DATA) → 554 5.6.0', () => {
    expectWellFormedReply(SMTP_REPLY_MIME_INVALID, 554, '5.6.0');
  });

  it('Domaine From non vérifié ou non possédé (fin DATA) → 550 5.7.1, définitif', () => {
    expectWellFormedReply(
      smtpReplyForError(refusalError(SEND_REFUSAL.DOMAIN_NOT_VERIFIED)),
      550,
      '5.7.1',
    );
  });

  it('From de test, destinataire ≠ adresse du compte (fin DATA) → 550 5.7.1', () => {
    expectWellFormedReply(
      smtpReplyForError(
        refusalError(SEND_REFUSAL.TEST_SENDER_RECIPIENT_RESTRICTED),
      ),
      550,
      '5.7.1',
    );
  });

  it('Domaine de TEST_EMAIL_FROM non VERIFIED — mauvaise config Zendou (fin DATA) → 451 4.3.0', () => {
    expectWellFormedReply(
      smtpReplyForError(refusalError(SEND_REFUSAL.TEST_SENDER_UNAVAILABLE)),
      451,
      '4.3.0',
    );
  });

  it('SES / base / Redis indisponible (fin DATA) → 451 4.3.0, temporaire', () => {
    // Ni HttpException, ni motif SEND_REFUSAL : une panne d'infrastructure.
    expectWellFormedReply(
      smtpReplyForError(new Error('ECONNREFUSED')),
      451,
      '4.3.0',
    );
  });
});

describe('smtpReplyForError — replis (refus non cartographié)', () => {
  it('un HttpException 4xx inconnue (hors SEND_REFUSAL) → 550 5.7.1', () => {
    const error = new NotFoundException('route inconnue');

    expect(smtpReplyForError(error)).toBe(SMTP_REPLY_UNKNOWN_CLIENT_REFUSAL);
    expect(smtpReplyForError(error).code).toBe(550);
    expect(smtpReplyForError(error).enhancedStatus).toBe('5.7.1');
  });

  it.each([500, 502, 503, 599])(
    'un HttpException %i (5xx) → 451 4.3.0',
    (status) => {
      const error = new HttpException('panne', status);

      expect(smtpReplyForError(error)).toBe(SMTP_REPLY_UNKNOWN_SERVER_ERROR);
    },
  );

  it('une erreur qui n’est pas une HttpException → 451 4.3.0', () => {
    expect(smtpReplyForError(new Error('bug interne'))).toBe(
      SMTP_REPLY_UNKNOWN_SERVER_ERROR,
    );
  });

  it.each([undefined, null, 'chaîne', 42, { message: 'objet nu' }])(
    'une valeur non-HttpException quelconque (%p) → 451 4.3.0, jamais une exception levée',
    (value) => {
      expect(() => smtpReplyForError(value)).not.toThrow();
      expect(smtpReplyForError(value)).toBe(SMTP_REPLY_UNKNOWN_SERVER_ERROR);
    },
  );
});

describe('smtpReplyForError — jamais 250 (test négatif explicite)', () => {
  const allDeclaredReplies: SmtpReply[] = [
    ...Object.values(SEND_REFUSAL_SMTP_REPLY),
    SMTP_REPLY_TOO_MANY_CONNECTIONS,
    SMTP_REPLY_AUTH_REQUIRES_TLS,
    SMTP_REPLY_AUTH_INVALID_CREDENTIALS,
    SMTP_REPLY_MAIL_FROM_REQUIRES_AUTH,
    SMTP_REPLY_SIZE_EXCEEDED,
    SMTP_REPLY_TOO_MANY_RECIPIENTS,
    SMTP_REPLY_MIME_INVALID,
    SMTP_REPLY_UNKNOWN_CLIENT_REFUSAL,
    SMTP_REPLY_UNKNOWN_SERVER_ERROR,
  ];

  it('aucune réponse exportée par ce module n’est un 250', () => {
    expect(allDeclaredReplies.length).toBeGreaterThan(0);

    for (const reply of allDeclaredReplies) {
      expect(reply.code).not.toBe(250);
    }
  });

  it.each(
    (Object.values(SEND_REFUSAL) as SendRefusalReason[]).map(
      (reason) => [reason] as const,
    ),
  )('smtpReplyForError() pour le motif %s n’est jamais 250', (reason) => {
    expect(smtpReplyForError(refusalError(reason)).code).not.toBe(250);
  });

  it('smtpReplyForError() pour toute erreur non cartographiée n’est jamais 250', () => {
    const candidates: unknown[] = [
      new Error('x'),
      new HttpException('x', 200),
      new HttpException('x', 302),
      new HttpException('x', 400),
      new HttpException('x', 499),
      undefined,
    ];

    for (const candidate of candidates) {
      expect(smtpReplyForError(candidate).code).not.toBe(250);
    }
  });
});
