import type { SmtpReply } from './smtp-reply';

/**
 * Constantes du pipeline SMTP (B6/S7) : réponses et textes que la table des
 * motifs `SEND_REFUSAL` de S8 ne couvre pas.
 *
 * Même discipline, et même raison d'être, que `smtp-throttle.constants.ts`
 * (S9) : `smtp-reply.ts` est la propriété exclusive de S8 et traduit les refus
 * **issus d'`EmailsService.accept()`**. Ce que S7 ajoute ici ne passe pas par
 * le point d'acceptation — un contenu non convertible est constaté sur les
 * octets seuls, et une acceptation n'est pas un refus. Aucun littéral de code
 * de réponse n'est écrit ailleurs que dans une constante `SmtpReply`.
 */

/**
 * §4.4 « MIME illisible » — fin DATA — `554 5.6.0`, appliqué au cas
 * particulier d'un message dont les octets ne survivent pas à une conversion
 * UTF-8 aller-retour.
 *
 * **Pourquoi ce refus existe.** Le message brut voyage jusqu'au worker dans la
 * charge utile BullMQ (A13), qui est sérialisée en **JSON** : elle ne peut
 * porter que du texte. Des octets qui ne forment pas de l'UTF-8 valide — un
 * corps en ISO-8859-1 annoncé `Content-Transfer-Encoding: 8bit`, une pièce
 * jointe binaire non encodée — seraient remplacés par le caractère de
 * remplacement `U+FFFD` au passage. Le message arriverait chez le destinataire
 * silencieusement corrompu : une facture illisible, des accents détruits.
 * **Refuser vaut mieux que livrer un message abîmé sans le dire.**
 *
 * Le texte oriente le client vers la correction réelle, qui est à sa portée et
 * standard depuis RFC 2045 : encoder le corps en `quoted-printable` ou en
 * `base64`. Tous les clients SMTP courants savent le faire ; c'est même leur
 * comportement par défaut dès qu'un jeu de caractères non ASCII est déclaré.
 * C'est aussi ce que demande SES pour un message brut — la documentation de
 * `RawMessage.Data` (`@aws-sdk/client-sesv2`) l'écrit noir sur blanc : « si
 * l'une des parties MIME contient du contenu hors de la plage ASCII 7 bits,
 * vous devriez l'encoder ». Le refus n'impose donc rien que le destinataire
 * n'aurait exigé plus tard, plus mal.
 *
 * 🔁 **Décision explicitement révisable** : le jour où le transport du brut
 * passe en base64 dans le job (repli prévu au plan), ce refus disparaît sans
 * rien changer d'autre — c'est une contrainte de transport interne, pas une
 * règle produit. Le refus est donc volontairement isolé ici, en un seul point,
 * plutôt que dissous dans le pipeline.
 */
export const SMTP_REPLY_RAW_NOT_UTF8: SmtpReply = {
  code: 554,
  enhancedStatus: '5.6.0',
  message:
    'Message refusé : son contenu n’est pas encodé en UTF-8. Encodez le corps et les pièces jointes avec un transfer-encoding standard (quoted-printable ou base64).',
};

/**
 * Statut étendu des réponses d'acceptation (`250`), §4.4 dernière ligne.
 *
 * Écrit par nos soins en tête du texte, comme tous les autres : `smtp-server`
 * ne transmet pas le statut étendu que l'application choisit (voir
 * `smtp-reply.adapter.ts`), et l'option `hideENHANCEDSTATUSCODES` neutralise
 * celui qu'il calculerait lui-même.
 */
export const SMTP_ACCEPTED_ENHANCED_STATUS = '2.0.0';

/**
 * Sujet inscrit sur la ligne `Email` quand le message n'a pas de `Subject:`,
 * ou qu'il en a un vide (§4.6, A12).
 *
 * `Email.subject` est une colonne non nulle, et un message SMTP peut
 * légitimement n'avoir aucun sujet. En contenu Raw ce champ n'est **plus qu'un
 * champ de journal** : le vrai en-tête — présent, absent ou vide — part intact
 * dans les octets d'origine. Ce libellé ne modifie donc jamais ce que le
 * destinataire reçoit, il rend seulement le journal lisible.
 */
export const SUBJECT_ABSENT_LABEL = '(sans objet)';

/** Issue d'un destinataire dans l'éventail de fin de `DATA` (§4.7). */
export type SmtpRecipientOutcome =
  | { kind: 'queued'; address: string; publicId: string }
  | { kind: 'suppressed'; address: string; publicId: string }
  | { kind: 'refused'; address: string; reason: string };

/**
 * Texte du `250` agrégé de fin de `DATA` (§4.7, règle d'agrégation).
 *
 * Une seule réponse SMTP doit couvrir N issues possibles. Le code dit
 * « message pris en charge » ; **le texte dit la vérité** — même philosophie
 * que le `250` « accepté sans expédition » de la liste de suppression (A9) :
 * l'identifiant public de chaque ligne créée permet au client de la retrouver
 * dans son journal, et chaque destinataire non expédié est nommé avec son
 * motif plutôt que passé sous silence.
 *
 * Tout tient sur **une seule ligne** : un saut de ligne dans un texte de
 * réponse désynchroniserait la conversation SMTP, le client lisant la suite
 * comme une nouvelle réponse.
 */
export function formatSmtpAcceptedReply(
  outcomes: readonly SmtpRecipientOutcome[],
): string {
  const parts = outcomes.map((outcome) => {
    switch (outcome.kind) {
      case 'queued':
        return `${outcome.address} accepté (${outcome.publicId})`;
      case 'suppressed':
        return `${outcome.address} accepté sans expédition — adresse sur liste de suppression (${outcome.publicId})`;
      default:
        return `${outcome.address} non accepté — ${outcome.reason}`;
    }
  });

  return `${SMTP_ACCEPTED_ENHANCED_STATUS} Message pris en charge : ${parts.join(' ; ')}`;
}
