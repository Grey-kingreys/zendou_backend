import {
  SMTP_REPLY_AUTH_INVALID_CREDENTIALS,
  SMTP_REPLY_AUTH_REQUIRES_TLS,
  SMTP_REPLY_MAIL_FROM_REQUIRES_AUTH,
  SMTP_REPLY_TOO_MANY_CONNECTIONS,
  SMTP_REPLY_UNKNOWN_SERVER_ERROR,
  type SmtpReply,
} from './smtp-reply';
import {
  formatSmtpReply,
  formatSmtpReplyLine,
  isSmtpReplyError,
  smtpReplyToError,
} from './smtp-reply.adapter';

describe('smtpReplyToError — pont vers smtp-server', () => {
  it('pose le code dans le champ que smtp-server lit réellement', () => {
    // Constat n°1 (hypothèse n°1 du plan) : `err.responseCode`, et lui seul.
    const error = smtpReplyToError(SMTP_REPLY_AUTH_INVALID_CREDENTIALS);

    expect(error.responseCode).toBe(535);
    expect(error).toBeInstanceOf(Error);
  });

  it('écrit le statut étendu en tête du message', () => {
    // Constat n°2 : aucun champ dédié n'existe, et la table interne de
    // `smtp-server` associerait au code un statut étendu différent de celui du
    // §4.4. Le seul chemin possible est le texte lui-même.
    const error = smtpReplyToError(SMTP_REPLY_AUTH_REQUIRES_TLS);

    expect(error.message).toBe(
      `5.7.11 ${SMTP_REPLY_AUTH_REQUIRES_TLS.message}`,
    );
  });

  it.each([
    SMTP_REPLY_AUTH_INVALID_CREDENTIALS,
    SMTP_REPLY_AUTH_REQUIRES_TLS,
    SMTP_REPLY_MAIL_FROM_REQUIRES_AUTH,
    SMTP_REPLY_TOO_MANY_CONNECTIONS,
    SMTP_REPLY_UNKNOWN_SERVER_ERROR,
  ])('restitue la réponse d’origine ($code $enhancedStatus)', (reply) => {
    const error = smtpReplyToError(reply);

    expect(error.smtpReply).toBe(reply);
    expect(formatSmtpReplyLine(reply)).toBe(
      `${reply.code} ${reply.enhancedStatus} ${reply.message}`,
    );
  });

  it('n’invente aucun texte : le message vient entièrement de la constante', () => {
    const reply: SmtpReply = {
      code: 451,
      enhancedStatus: '4.3.0',
      message: 'Texte arbitraire.',
    };

    expect(formatSmtpReply(reply)).toBe('4.3.0 Texte arbitraire.');
  });
});

describe('isSmtpReplyError — refus délibéré contre exception inattendue', () => {
  it('reconnaît un refus fabriqué par l’adaptateur', () => {
    expect(
      isSmtpReplyError(smtpReplyToError(SMTP_REPLY_TOO_MANY_CONNECTIONS)),
    ).toBe(true);
  });

  it.each([
    ['une erreur ordinaire', new Error('panne base')],
    // Une erreur qui imiterait la forme attendue ne doit pas passer pour un
    // refus : la marque est un symbole, inatteignable par accident.
    ['une imitation', Object.assign(new Error('faux'), { responseCode: 535 })],
    ['null', null],
    ['une chaîne', 'erreur'],
  ])('rejette %s', (_label, candidate) => {
    expect(isSmtpReplyError(candidate)).toBe(false);
  });
});
