/**
 * Messages MIME de test du relais SMTP (B6/S6).
 *
 * Les messages sont construits **en TypeScript avec des terminateurs de ligne
 * explicites** plutôt que stockés en fichiers `.eml` : le module se juge à
 * l'octet près (le corps doit ressortir hash-identique), et un `.eml` sur
 * disque est à la merci d'une normalisation de fins de ligne par git ou par un
 * éditeur — la panne serait silencieuse et le test deviendrait faux sans
 * jamais rougir.
 *
 * Chaque fixture expose le message complet **et son corps seul**, pour que la
 * spec puisse comparer le corps d'origine à celui du message réécrit.
 */

/** Un message brut de test et le corps qu'il doit préserver. */
export interface MimeFixture {
  /** Message complet, tel qu'il sortirait de la commande `DATA`. */
  raw: Buffer;
  /** Corps seul, séparateur exclu : ce que la réécriture ne doit pas toucher. */
  body: Buffer;
}

/** Assemble des lignes en CRLF, terminateur final compris. */
function crlf(lines: string[]): string {
  return lines.map((line) => `${line}\r\n`).join('');
}

/** Construit un message canonique : en-têtes CRLF, ligne vide, corps CRLF. */
function build(headerLines: string[], bodyLines: string[]): MimeFixture {
  const body = crlf(bodyLines);

  return {
    raw: Buffer.from(`${crlf(headerLines)}\r\n${body}`, 'utf8'),
    body: Buffer.from(body, 'utf8'),
  };
}

/**
 * Corps `multipart/mixed` avec pièce jointe encodée en base64.
 *
 * Ses parties portent leurs propres lignes `Content-Type:` et leurs propres
 * lignes vides : si la découpe se faisait ailleurs qu'à la **première** ligne
 * vide, ces lignes seraient prises pour des en-têtes de message.
 */
const MULTIPART_BODY = [
  '--limite-42',
  'Content-Type: text/plain; charset=UTF-8',
  '',
  'Bonjour Awa,',
  'Votre facture est en pièce jointe.',
  '',
  '--limite-42',
  'Content-Type: application/pdf; name="facture-42.pdf"',
  'Content-Transfer-Encoding: base64',
  'Content-Disposition: attachment; filename="facture-42.pdf"',
  '',
  'JVBERi0xLjQKJcOkw7zDtsOfCjIgMCBvYmoKPDwvTGVuZ3RoIDMgMCBSPj4Kc3Ry',
  'ZWFtCkJUCi9GMSAxMiBUZgoxMDAgNzAwIFRkCihGYWN0dXJlIDQyKSBUagpFVAo=',
  '',
  '--limite-42--',
];

/** Corps texte simple, pour les fixtures qui ne visent pas le multipart. */
const PLAIN_BODY = ['Bonjour,', '', 'Votre facture est disponible.'];

/**
 * Sujet en quoted-printable RFC 2047.
 * Attendu : « Facture n° 42 pour la Société ».
 */
export const quotedPrintableSubjectFixture = (): MimeFixture =>
  build(
    [
      'From: Awa Diallo <contact@boutique-awa.gn>',
      'To: client@exemple.gn',
      'Subject: =?UTF-8?Q?Facture_n=C2=B0_42_pour_la_Soci=C3=A9t=C3=A9?=',
      'Message-ID: <qp-1@boutique-awa.gn>',
      'Date: Tue, 19 Aug 2026 09:12:00 +0000',
    ],
    PLAIN_BODY,
  );

/**
 * Sujet en base64 UTF-8 RFC 2047.
 * Attendu : « Félicitations : votre commande est prête ».
 */
export const base64SubjectFixture = (): MimeFixture =>
  build(
    [
      'From: contact@boutique-awa.gn',
      'To: client@exemple.gn',
      'Subject: =?UTF-8?B?RsOpbGljaXRhdGlvbnMgOiB2b3RyZSBjb21tYW5kZSBlc3QgcHLDqnRl?=',
      'Message-ID: <b64-1@boutique-awa.gn>',
    ],
    PLAIN_BODY,
  );

/**
 * `Subject:` en clair replié sur **trois** lignes, et `To:` replié avec une
 * tabulation en tête de continuation.
 * Attendu : « Facture 42 pour la Société Guinéenne de Distribution ».
 */
export const foldedSubjectFixture = (): MimeFixture =>
  build(
    [
      'From: Awa Diallo <contact@boutique-awa.gn>',
      'To: comptabilite@societe-guineenne.gn,',
      '\tdirection@societe-guineenne.gn',
      'Subject: Facture 42 pour la',
      ' Société Guinéenne de',
      ' Distribution',
      'Message-ID: <plie-1@boutique-awa.gn>',
    ],
    PLAIN_BODY,
  );

/**
 * Sujet encodé **découpé en trois mots encodés repliés** — la forme que
 * produisent les clients pour un sujet long et accentué. Les blancs de
 * repliage entre deux mots encodés doivent disparaître (RFC 2047 §6.2).
 * Attendu : « Félicitations : votre commande est prête ».
 */
export const foldedEncodedSubjectFixture = (): MimeFixture =>
  build(
    [
      'From: Awa Diallo <contact@boutique-awa.gn>',
      'To: client@exemple.gn',
      'Subject: =?UTF-8?B?RsOpbGljaXRhdGlvbnMgOiA=?=',
      ' =?UTF-8?B?dm90cmUgY29tbWFuZGUg?=',
      ' =?UTF-8?B?ZXN0IHByw6p0ZQ==?=',
      'Message-ID: <plie-2@boutique-awa.gn>',
    ],
    PLAIN_BODY,
  );

/**
 * Terminateurs de ligne mélangés : CRLF, LF nu, continuation de repliage
 * introduite par un LF, séparateur en LF seul, corps en LF puis CRLF.
 * Attendu : sujet « Relevé du mois », `Bcc:` retiré, corps intact.
 */
export const mixedLineEndingsFixture = (): MimeFixture => {
  const body = 'Première ligne\nDeuxième ligne\r\n';

  const raw =
    'From: Awa Diallo <contact@boutique-awa.gn>\r\n' +
    'To: comptabilite@societe-guineenne.gn\n' +
    'Bcc: discret@boutique-awa.gn\n' +
    'Subject: Relevé\n' +
    ' du mois\r\n' +
    'Message-ID: <mixte-1@boutique-awa.gn>\n' +
    '\n' +
    body;

  return { raw: Buffer.from(raw, 'utf8'), body: Buffer.from(body, 'utf8') };
};

/** Deux en-têtes `From:` : ambiguïté d'identité DKIM, à refuser (§4.3). */
export const duplicateFromFixture = (): MimeFixture =>
  build(
    [
      'From: Awa Diallo <contact@boutique-awa.gn>',
      'To: client@exemple.gn',
      'From: Service <facturation@banque-tierce.gn>',
      'Subject: Facture',
    ],
    PLAIN_BODY,
  );

/** Deux adresses dans le **même** `From:` : même ambiguïté, même refus. */
export const multipleAddressesInFromFixture = (): MimeFixture =>
  build(
    [
      'From: Awa Diallo <contact@boutique-awa.gn>, Service <facturation@banque-tierce.gn>',
      'To: client@exemple.gn',
      'Subject: Facture',
    ],
    PLAIN_BODY,
  );

/**
 * `Bcc:` replié sur deux lignes, au milieu d'un message à pièce jointe.
 * Attendu : les **deux** lignes du `Bcc:` disparaissent, le corps multipart
 * reste hash-identique.
 */
export const bccWithAttachmentFixture = (): MimeFixture =>
  build(
    [
      'From: Awa Diallo <contact@boutique-awa.gn>',
      'To: client@exemple.gn',
      'Bcc: comptabilite@boutique-awa.gn,',
      ' archives@boutique-awa.gn',
      'Subject: Votre facture',
      'Message-ID: <bcc-1@boutique-awa.gn>',
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="limite-42"',
    ],
    MULTIPART_BODY,
  );

/** Le même message sans `Bcc:` : référence octet pour octet de la réécriture. */
export const attachmentWithoutBccFixture = (): MimeFixture =>
  build(
    [
      'From: Awa Diallo <contact@boutique-awa.gn>',
      'To: client@exemple.gn',
      'Subject: Votre facture',
      'Message-ID: <bcc-1@boutique-awa.gn>',
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="limite-42"',
    ],
    MULTIPART_BODY,
  );

/**
 * En-têtes reposés par SES (`Sender:`, `Return-Path:`) et en-têtes de
 * réexpédition (`Resent-*`), dont un `Resent-Bcc:` replié.
 * Attendu : tous retirés, `Message-ID:` et `Reply-To:` conservés.
 */
export const resentHeadersFixture = (): MimeFixture =>
  build(
    [
      'Return-Path: <rebond@boutique-awa.gn>',
      'From: Awa Diallo <contact@boutique-awa.gn>',
      'Sender: robot@boutique-awa.gn',
      'To: client@exemple.gn',
      'Reply-To: sav@boutique-awa.gn',
      'Resent-From: ancien@boutique-awa.gn',
      'Resent-Date: Mon, 18 Aug 2026 08:00:00 +0000',
      'Resent-Bcc: veille@boutique-awa.gn,',
      ' archives@boutique-awa.gn',
      'Resent-Message-ID: <reexp-1@boutique-awa.gn>',
      'Subject: Relance',
      'Message-ID: <conserve-1@boutique-awa.gn>',
    ],
    PLAIN_BODY,
  );

/** Aucun `Subject:` : l'appelant inscrira « (sans objet) » (§4.6). */
export const withoutSubjectFixture = (): MimeFixture =>
  build(
    [
      'From: Awa Diallo <contact@boutique-awa.gn>',
      'To: client@exemple.gn',
      'Message-ID: <sans-sujet-1@boutique-awa.gn>',
    ],
    PLAIN_BODY,
  );

/** `Subject:` présent mais vide : même repli attendu côté appelant. */
export const emptySubjectFixture = (): MimeFixture =>
  build(
    [
      'From: Awa Diallo <contact@boutique-awa.gn>',
      'To: client@exemple.gn',
      'Subject:',
      'Message-ID: <sujet-vide-1@boutique-awa.gn>',
    ],
    PLAIN_BODY,
  );

/**
 * Sujet de 420 caractères : la troncature à `SUBJECT_MAX_LENGTH` est un choix
 * de stockage de l'appelant, jamais du module (§4.6).
 */
export const longSubjectFixture = (): MimeFixture =>
  build(
    [
      'From: Awa Diallo <contact@boutique-awa.gn>',
      'To: client@exemple.gn',
      `Subject: ${'Facture 42 pour la Société Guinéenne de Distribution. '.repeat(8).trim()}`,
    ],
    PLAIN_BODY,
  );

/** Aucun `From:` : l'appelant injectera celui de l'enveloppe (§4.3). */
export const withoutFromFixture = (): MimeFixture =>
  build(
    [
      'To: client@exemple.gn',
      'Subject: Facture 42',
      'Message-ID: <sans-from-1@boutique-awa.gn>',
    ],
    PLAIN_BODY,
  );

/** `From:` présent mais illisible. */
export const invalidFromFixture = (): MimeFixture =>
  build(
    ['From: Awa Diallo', 'To: client@exemple.gn', 'Subject: Facture 42'],
    PLAIN_BODY,
  );

/**
 * Nom d'affichage entre guillemets contenant une virgule : une seule boîte aux
 * lettres, pas deux.
 */
export const quotedCommaDisplayNameFixture = (): MimeFixture =>
  build(
    [
      'From: "Diallo, Awa" <contact@boutique-awa.gn>',
      'To: client@exemple.gn',
      'Subject: Facture 42',
    ],
    PLAIN_BODY,
  );

/** Nom d'affichage encodé RFC 2047. Attendu : « Awa Diallô ». */
export const encodedDisplayNameFixture = (): MimeFixture =>
  build(
    [
      'From: =?UTF-8?Q?Awa_Diall=C3=B4?= <contact@boutique-awa.gn>',
      'To: client@exemple.gn',
      'Subject: Facture 42',
    ],
    PLAIN_BODY,
  );

/** Ligne d'archive mbox en tête : le bloc d'en-têtes est illisible. */
export const mboxPrefixFixture = (): MimeFixture => {
  const fixture = build(
    ['From: Awa Diallo <contact@boutique-awa.gn>', 'Subject: Facture 42'],
    PLAIN_BODY,
  );

  return {
    raw: Buffer.concat([
      Buffer.from('From boutique-awa.gn Tue Aug 19 09:12:00 2026\r\n', 'utf8'),
      fixture.raw,
    ]),
    body: fixture.body,
  };
};

/** Continuation de repliage sans champ à replier : bloc d'en-têtes illisible. */
export const orphanFoldFixture = (): MimeFixture =>
  build([' suite sans champ', 'From: contact@boutique-awa.gn'], PLAIN_BODY);

/** Message réduit à ses en-têtes, sans ligne vide ni corps. */
export const headersOnlyFixture = (): MimeFixture => ({
  raw: Buffer.from(
    crlf([
      'From: Awa Diallo <contact@boutique-awa.gn>',
      'Bcc: discret@boutique-awa.gn',
      'Subject: Ping',
    ]),
    'utf8',
  ),
  body: Buffer.alloc(0),
});
