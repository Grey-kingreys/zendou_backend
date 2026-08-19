import libmime from 'libmime';

import { parseEmailAddress } from '../emails/email-address';
import type { ParsedAddress } from '../emails/email-address';

/**
 * En-têtes MIME du relais SMTP : découpe, analyse et réécriture chirurgicale.
 *
 * Règle de conception (B6 §2.2) : **on analyse pour décider, on transmet les
 * octets d'origine.** Le message expédié à SES doit être celui reçu du client,
 * jamais un message recomposé — recomposer changerait les
 * `Content-Transfer-Encoding`, réordonnerait les en-têtes et casserait des
 * `multipart` limites-sensibles.
 *
 * Ce module est **entièrement pur** : aucun accès réseau, base, Redis ni Nest.
 * Il ne lève jamais d'exception métier — un contenu inacceptable ressort en
 * `MimeHeaderRefusal`, à charge de l'appelant (B6/S7 puis S8) de le traduire
 * en code de réponse SMTP.
 *
 * Dépendance externe unique : `libmime` (famille Nodemailer), pour le décodage
 * des mots encodés RFC 2047. C'est exactement la bibliothèque que `mailparser`
 * utilise en interne pour ce travail ; on prend la sous-bibliothèque plutôt
 * que `mailparser` parce que le repli documenté en §2.2 (« parseur d'en-têtes
 * maison + `mailparser` uniquement pour le décodage des mots encodés ») est
 * précisément ce qui est implémenté ici.
 */

/** Retour chariot. */
const CR = 0x0d;
/** Saut de ligne. */
const LF = 0x0a;
/** Deux-points : sépare le nom d'un champ d'en-tête de sa valeur. */
const COLON = 0x3a;
/** Espace. */
const SPACE = 0x20;
/** Tabulation horizontale. */
const TAB = 0x09;

/** Premier octet imprimable admis dans un nom de champ (RFC 5322 `ftext`). */
const FIELD_NAME_MIN_BYTE = 33;
/** Dernier octet imprimable admis dans un nom de champ (RFC 5322 `ftext`). */
const FIELD_NAME_MAX_BYTE = 126;

const EMPTY = Buffer.alloc(0);

/**
 * En-têtes retirés des octets bruts avant transmission (B6 §4.3), comparés en
 * minuscules.
 *
 * - `bcc` : sans ce retrait, les adresses en copie cachée fuitent chez tous
 *   les destinataires.
 * - `sender`, `return-path` : SES les repose lui-même.
 *
 * `message-id` est délibérément **absent** de cette liste : celui du client est
 * conservé s'il existe.
 */
export const STRIPPED_HEADER_NAMES: readonly string[] = [
  'bcc',
  'return-path',
  'sender',
];

/**
 * Préfixe des en-têtes de réexpédition (`Resent-From`, `Resent-Date`,
 * `Resent-Bcc`…), retirés en bloc (B6 §4.3).
 */
export const STRIPPED_HEADER_PREFIX = 'resent-';

/** Indique si un nom d'en-tête (en minuscules) doit être retiré du message. */
export function isStrippedHeader(key: string): boolean {
  return (
    STRIPPED_HEADER_NAMES.includes(key) ||
    key.startsWith(STRIPPED_HEADER_PREFIX)
  );
}

/**
 * Motifs de refus d'un message à l'analyse de ses en-têtes.
 *
 * Volontairement distincts de `SEND_REFUSAL` (`emails.constants.ts`) : ceux-ci
 * sont constatés **avant** le point d'acceptation, sur les octets seuls, sans
 * rien savoir du compte ni de ses domaines. Les trois relèvent du même code de
 * réponse `554 5.6.0` (« contenu invalide », B6 §4.4), mais la table de
 * correspondance vit en S8 — pas ici.
 */
export const MIME_REFUSAL = {
  /**
   * Bloc d'en-têtes illisible : ligne sans nom de champ (une ligne `From `
   * d'archive mbox, par exemple) ou ligne de repliage sans champ à replier.
   */
  MALFORMED_HEADERS: 'MALFORMED_HEADERS',
  /**
   * Plusieurs `From:` — soit deux en-têtes, soit deux adresses dans le même
   * en-tête. Refusé dans les deux cas : SES choisit l'identité de signature
   * DKIM d'après le domaine du `From:`, et l'ambiguïté est exploitable
   * (B6 §4.3).
   */
  MULTIPLE_FROM: 'MULTIPLE_FROM',
  /** `From:` présent mais illisible. */
  INVALID_FROM: 'INVALID_FROM',
} as const;

/** Motif de refus constaté à l'analyse MIME. */
export type MimeRefusalReason =
  (typeof MIME_REFUSAL)[keyof typeof MIME_REFUSAL];

/** Découpe d'un message brut en trois tranches d'octets contiguës. */
export interface RawMessageParts {
  /** Bloc d'en-têtes, séparateur exclu. Vide si le message n'en a pas. */
  headers: Buffer;
  /** Ligne vide séparant les en-têtes du corps, telle que reçue. */
  separator: Buffer;
  /** Corps du message. **Jamais modifié.** */
  body: Buffer;
}

/** Un champ d'en-tête, replié ou non. */
export interface MimeHeaderField {
  /** Nom tel qu'écrit par le client (« Subject », « BCC »…). */
  name: string;
  /** Nom en minuscules : la comparaison des noms est insensible à la casse. */
  key: string;
  /**
   * Valeur dépliée (RFC 5322 §2.2.3 : les CRLF de repliage disparaissent, les
   * blancs qui les suivaient restent), débarrassée de ses blancs de bord.
   *
   * Les octets sont décodés en UTF-8 — un client `SMTPUTF8` peut envoyer un
   * sujet en clair non ASCII. Les mots encodés RFC 2047 ne sont **pas**
   * décodés ici : c'est le rôle de `decodeEncodedWords`.
   */
  value: string;
  /** Décalage du premier octet du champ dans le bloc d'en-têtes. */
  start: number;
  /** Décalage de fin, exclu, terminateur de ligne compris. */
  end: number;
}

/** Message dont les en-têtes interdits ont été retirés. */
export interface StrippedMessage {
  /** Octets complets du message réécrit. */
  raw: Buffer;
  /** Noms des champs retirés, dans l'ordre d'apparition. */
  stripped: string[];
}

/** Analyse réussie : ce dont B6/S7 a besoin pour appeler `accept()`. */
export interface MimeHeaderAnalysis {
  ok: true;
  /**
   * `From:` d'en-tête analysé — c'est lui qui fait foi et qui alimente
   * `Email.fromAddress` (B6 §4.3). **Absent** quand le message n'a pas de
   * `From:` : l'appelant injecte alors celui de l'enveloppe.
   */
  from?: ParsedAddress;
  /**
   * `Subject:` décodé (RFC 2047), **non tronqué** : la troncature à
   * `SUBJECT_MAX_LENGTH` est un choix de stockage de l'appelant (B6 §4.6), et
   * le vrai en-tête part intact dans les octets d'origine.
   *
   * **Absent** quand le message n'a pas de `Subject:` — l'appelant inscrit
   * alors « (sans objet) » en base. Un `Subject:` présent mais vide ressort en
   * chaîne vide et appelle le même repli : tester la valeur, pas seulement sa
   * présence.
   */
  subject?: string;
  /**
   * Octets du message à transmettre à SES : les en-têtes interdits en moins,
   * **corps identique octet pour octet** à celui reçu.
   */
  raw: Buffer;
  /** Noms des en-têtes effectivement retirés, pour le journal. */
  strippedHeaders: string[];
}

/** Analyse refusée. Aucun octet n'est réécrit dans ce cas. */
export interface MimeHeaderRefusal {
  ok: false;
  reason: MimeRefusalReason;
}

/** Issue de `analyzeRawMessage`, en union discriminée sur `ok`. */
export type MimeHeaderResult = MimeHeaderAnalysis | MimeHeaderRefusal;

/**
 * Coupe un message brut à la première ligne vide.
 *
 * Le séparateur canonique est `CRLF CRLF`, mais on tolère `LF LF` ainsi que
 * les formes mixtes `CRLF LF` et `LF CRLF` : un client mal élevé, ou un
 * message relu depuis un fichier normalisé, ne doit pas devenir illisible.
 *
 * Sans ligne vide, tout le message est considéré comme un bloc d'en-têtes et
 * le corps est vide.
 *
 * Invariant : `concat(headers, separator, body)` redonne exactement `raw`.
 */
export function splitRawMessage(raw: Buffer): RawMessageParts {
  let lineStart = 0;

  for (let index = 0; index < raw.length; index++) {
    if (raw[index] !== LF) {
      continue;
    }

    // Fin du contenu de la ligne : le CR d'un CRLF n'en fait pas partie.
    const contentEnd =
      index > lineStart && raw[index - 1] === CR ? index - 1 : index;

    if (contentEnd === lineStart) {
      return {
        headers: raw.subarray(0, lineStart),
        separator: raw.subarray(lineStart, index + 1),
        body: raw.subarray(index + 1),
      };
    }

    lineStart = index + 1;
  }

  return { headers: raw, separator: EMPTY, body: EMPTY };
}

/**
 * Découpe un bloc d'en-têtes en champs, repliage RFC 5322 compris.
 *
 * Renvoie `null` si le bloc est illisible — une ligne qui n'est ni un champ
 * (`nom: valeur`) ni une continuation (ligne commençant par une espace ou une
 * tabulation).
 *
 * Les champs couvrent le bloc **sans trou ni recouvrement** : le premier
 * commence à 0, chaque champ finit là où le suivant commence, et le dernier
 * finit à la fin du bloc. C'est ce qui rend `stripForbiddenHeaders` exact.
 */
export function parseMimeHeaders(headers: Buffer): MimeHeaderField[] | null {
  const fields: MimeHeaderField[] = [];
  let lineStart = 0;

  while (lineStart < headers.length) {
    const lineFeed = headers.indexOf(LF, lineStart);
    const lineEnd = lineFeed === -1 ? headers.length : lineFeed + 1;
    const first = headers[lineStart];

    if (first === SPACE || first === TAB) {
      const previous = fields[fields.length - 1];

      if (!previous) {
        return null;
      }

      previous.end = lineEnd;
      lineStart = lineEnd;
      continue;
    }

    const colon = headers.indexOf(COLON, lineStart);

    if (colon === -1 || colon >= lineEnd || colon === lineStart) {
      return null;
    }

    if (!isFieldName(headers, lineStart, colon)) {
      return null;
    }

    // Le nom est de l'ASCII imprimable : `latin1` donne un caractère par
    // octet, donc `name.length` vaut exactement `colon - lineStart`.
    const name = headers.toString('latin1', lineStart, colon);

    fields.push({
      name,
      key: name.toLowerCase(),
      value: '',
      start: lineStart,
      end: lineEnd,
    });

    lineStart = lineEnd;
  }

  // La valeur n'est lisible qu'une fois `end` définitif, c'est-à-dire une fois
  // toutes les lignes de repliage du champ absorbées.
  for (const field of fields) {
    const valueStart = field.start + field.name.length + 1;

    field.value = unfoldValue(headers.toString('utf8', valueStart, field.end));
  }

  return fields;
}

/**
 * Décode les mots encodés RFC 2047 (`=?UTF-8?B?…?=`, `=?ISO-8859-1?Q?…?=`)
 * d'une valeur d'en-tête déjà dépliée.
 *
 * Point de dépendance unique à `libmime`. `decodeWords` est une méthode
 * d'instance qui délègue à `this.decodeWord` : elle doit être appelée sur
 * l'objet exporté, jamais déstructurée.
 *
 * Une chaîne sans mot encodé, ou dont le mot encodé est mal formé, ressort
 * inchangée.
 */
export function decodeEncodedWords(value: string): string {
  return libmime.decodeWords(value);
}

/**
 * Réécrit le bloc d'en-têtes en retirant les champs interdits (§4.3), et
 * laisse le corps strictement intact.
 *
 * La réécriture se fait **par tranches d'octets** : les champs conservés sont
 * recopiés tels quels, repliage et terminateurs de ligne d'origine compris.
 * On ne recompose jamais un champ à partir de sa valeur dépliée — ce serait
 * modifier des en-têtes qu'on n'a aucune raison de toucher. Le corps et le
 * séparateur sont recopiés à l'identique.
 *
 * Conséquence testable : quand aucun champ n'est retiré, la sortie est
 * l'entrée, octet pour octet.
 */
export function stripForbiddenHeaders(
  parts: RawMessageParts,
  fields: MimeHeaderField[],
): StrippedMessage {
  const stripped: string[] = [];
  const kept: Buffer[] = [];

  for (const field of fields) {
    if (isStrippedHeader(field.key)) {
      stripped.push(field.name);
      continue;
    }

    kept.push(parts.headers.subarray(field.start, field.end));
  }

  return {
    raw: Buffer.concat([...kept, parts.separator, parts.body]),
    stripped,
  };
}

/**
 * Analyse un message brut reçu en `DATA` et en renvoie la version à expédier.
 *
 * Point d'entrée du module pour B6/S7. Ne lève jamais : un message inacceptable
 * ressort en `{ ok: false, reason }`.
 */
export function analyzeRawMessage(raw: Buffer): MimeHeaderResult {
  const parts = splitRawMessage(raw);
  const fields = parseMimeHeaders(parts.headers);

  if (!fields) {
    return { ok: false, reason: MIME_REFUSAL.MALFORMED_HEADERS };
  }

  const fromFields = fields.filter((field) => field.key === 'from');

  if (fromFields.length > 1) {
    return { ok: false, reason: MIME_REFUSAL.MULTIPLE_FROM };
  }

  let from: ParsedAddress | undefined;

  if (fromFields.length === 1) {
    const mailboxes = splitMailboxList(fromFields[0].value);

    if (mailboxes.length > 1) {
      return { ok: false, reason: MIME_REFUSAL.MULTIPLE_FROM };
    }

    const parsed =
      mailboxes.length === 1 ? parseEmailAddress(mailboxes[0]) : null;

    if (!parsed) {
      return { ok: false, reason: MIME_REFUSAL.INVALID_FROM };
    }

    from = decodeDisplayName(parsed);
  }

  // Un second `Subject:` est du bruit d'injection d'en-tête : on retient le
  // premier, comme le fait tout agent de messagerie, et le message part avec
  // ses octets d'origine de toute façon.
  const subjectField = fields.find((field) => field.key === 'subject');
  const { raw: rewritten, stripped } = stripForbiddenHeaders(parts, fields);

  return {
    ok: true,
    from,
    subject: subjectField ? decodeEncodedWords(subjectField.value) : undefined,
    raw: rewritten,
    strippedHeaders: stripped,
  };
}

/** Vérifie que les octets `[start, end)` forment un nom de champ RFC 5322. */
function isFieldName(headers: Buffer, start: number, end: number): boolean {
  for (let index = start; index < end; index++) {
    const byte = headers[index];

    if (byte < FIELD_NAME_MIN_BYTE || byte > FIELD_NAME_MAX_BYTE) {
      return false;
    }
  }

  return true;
}

/**
 * Déplie une valeur d'en-tête : le repliage RFC 5322 §2.2.3 retire le CRLF et
 * conserve le blanc qui le suivait. Le terminateur de la dernière ligne
 * disparaît par la même occasion, et `trim` enlève les blancs de bord.
 */
function unfoldValue(value: string): string {
  return value.replace(/\r?\n/g, '').trim();
}

/**
 * Découpe une liste de boîtes aux lettres sur les virgules **de premier
 * niveau**.
 *
 * Ce n'est pas une seconde analyse d'adresse — la seule reste
 * `parseEmailAddress` (`emails/email-address.ts`). C'est uniquement ce qu'il
 * faut pour compter les boîtes : une virgule à l'intérieur d'un nom entre
 * guillemets (`"Diallo, Awa" <a@b.gn>`), d'un commentaire (`(bureau, Conakry)`)
 * ou de chevrons ne sépare rien.
 *
 * Sans ce comptage, `From: Awa <a@b.gn>, Mamadou <m@c.gn>` serait accepté avec
 * la **dernière** adresse — exactement l'ambiguïté que §4.3 veut refuser.
 */
function splitMailboxList(value: string): string[] {
  const mailboxes: string[] = [];
  let current = '';
  let quoted = false;
  let angled = false;
  let commentDepth = 0;
  let escaped = false;

  for (const character of value) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }

    if (character === '\\') {
      current += character;
      escaped = true;
      continue;
    }

    if (quoted) {
      current += character;
      quoted = character !== '"';
      continue;
    }

    if (commentDepth > 0) {
      current += character;

      if (character === '(') {
        commentDepth++;
      } else if (character === ')') {
        commentDepth--;
      }

      continue;
    }

    if (character === ',' && !angled) {
      mailboxes.push(current);
      current = '';
      continue;
    }

    if (character === '"') {
      quoted = true;
    } else if (character === '(') {
      commentDepth++;
    } else if (character === '<') {
      angled = true;
    } else if (character === '>') {
      angled = false;
    }

    current += character;
  }

  mailboxes.push(current);

  return mailboxes
    .map((mailbox) => mailbox.trim())
    .filter((mailbox) => mailbox.length > 0);
}

/**
 * Décode les mots encodés du nom d'affichage, une fois l'adresse analysée.
 *
 * L'ordre importe : on analyse d'abord, on décode ensuite. Décoder avant
 * laisserait le contenu décodé — qui peut contenir `<`, `>` ou `,` — modifier
 * la structure lue par `parseEmailAddress`.
 */
function decodeDisplayName(parsed: ParsedAddress): ParsedAddress {
  if (!parsed.name) {
    return parsed;
  }

  const name = decodeEncodedWords(parsed.name).trim();

  return name
    ? { ...parsed, name }
    : { address: parsed.address, domain: parsed.domain };
}
