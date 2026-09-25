/** Nom du cookie de session posé sur le navigateur. */
export const SESSION_COOKIE_NAME = 'zendou_session';

/** Durée de vie d'une session (glissante) : 7 jours. */
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;

/** Préfixe des clés Redis stockant les sessions. */
export const SESSION_KEY_PREFIX = 'sess:';

/** Token d'injection du client Redis dédié aux sessions. */
export const SESSION_REDIS = 'AUTH_SESSION_REDIS';

/**
 * Message unique renvoyé pour tout échec d'authentification :
 * email inconnu et mot de passe faux sont indiscernables (pas d'oracle).
 */
export const INVALID_CREDENTIALS_MESSAGE = 'Email ou mot de passe incorrect';

/** Message renvoyé lorsqu'une adresse email est déjà enregistrée. */
export const EMAIL_ALREADY_USED_MESSAGE =
  'Cette adresse email est déjà utilisée';

/** Message renvoyé quand `PATCH /v1/auth/me` reçoit un body sans aucun champ. */
export const NO_CHANGES_MESSAGE = 'Aucune modification fournie';

/**
 * Message renvoyé quand `currentPassword` fourni à
 * `POST /v1/auth/change-password` est incorrect.
 * Volontairement distinct de `INVALID_CREDENTIALS_MESSAGE` (login) :
 * ici l'utilisateur est déjà authentifié, son email est déjà connu de lui
 * comme du serveur, donc préciser que c'est le mot de passe qui est faux
 * ne permet aucune énumération de comptes.
 */
export const WRONG_CURRENT_PASSWORD_MESSAGE = 'Mot de passe actuel incorrect';

/** Message renvoyé quand le nouveau mot de passe est identique à l'actuel. */
export const SAME_PASSWORD_MESSAGE =
  "Le nouveau mot de passe doit être différent de l'actuel";

/**
 * Préfixe des clés Redis indexant, par utilisateur, l'ensemble des tokens de
 * session actifs : `usersess:<userId>` -> Set<token>. Permet de révoquer
 * toutes les sessions d'un utilisateur (ex. changement de mot de passe)
 * sans SCAN sur tout Redis.
 */
export const SESSION_USER_SET_PREFIX = 'usersess:';

/**
 * Verrouillage progressif de la connexion (`LoginLockoutService`).
 *
 * Complète la limitation de débit sans la remplacer : celle-ci borne le
 * *rythme* (5 tentatives par minute et par IP), celui-là borne
 * l'*acharnement* dans la durée sur **une adresse donnée**, quelle que soit
 * l'IP d'où viennent les tentatives. Un attaquant qui dispose d'un parc d'IP -
 * ce que le NAT opérateur guinéen rend d'ailleurs banal - passe entre les
 * mailles de la première ; il bute sur le second.
 *
 * Les trois clés sont indexées par l'empreinte SHA-256 de l'adresse
 * normalisée : Redis ne contient jamais d'email en clair.
 */

/** Compteur d'échecs de la fenêtre courante : `lockout:fail:<sha256(email)>`. */
export const LOGIN_LOCKOUT_FAIL_PREFIX = 'lockout:fail:';

/** Marque de blocage en cours : `lockout:block:<sha256(email)>`. */
export const LOGIN_LOCKOUT_BLOCK_PREFIX = 'lockout:block:';

/**
 * Niveau d'escalade atteint : `lockout:level:<sha256(email)>`. Sa durée de vie
 * (24 h) est ce qui fait tenir le doublement dans le temps ; sans elle, un
 * attaquant patient repartirait indéfiniment du premier palier.
 */
export const LOGIN_LOCKOUT_LEVEL_PREFIX = 'lockout:level:';

/** Durée de vie du niveau d'escalade, en secondes (24 h). */
export const LOGIN_LOCKOUT_LEVEL_TTL_SECONDS = 86_400;

/**
 * Défauts du verrouillage, tous ajustables par variable d'environnement
 * (validées dans `src/config/env.schema.ts`, documentées dans `.env.example`).
 */
export const LOGIN_LOCKOUT_DEFAULTS = {
  /** `LOGIN_LOCKOUT_THRESHOLD` - échecs tolérés avant le blocage suivant. */
  THRESHOLD: 5,
  /** `LOGIN_LOCKOUT_BASE_SECONDS` - durée du premier blocage. */
  BASE_SECONDS: 60,
  /**
   * `LOGIN_LOCKOUT_MAX_SECONDS` - plafond du doublement (une heure). Au-delà,
   * le verrouillage cesserait de protéger le titulaire du compte pour se
   * mettre à le punir : quelqu'un peut bloquer l'adresse d'un tiers rien qu'en
   * échouant sur elle.
   */
  MAX_SECONDS: 3600,
  /**
   * `LOGIN_LOCKOUT_WINDOW_SECONDS` - durée de vie du compteur d'échecs. Cinq
   * fautes de frappe étalées sur une journée ne doivent rien déclencher.
   */
  WINDOW_SECONDS: 900,
} as const;

/**
 * Discriminant stable des refus « ce compte n'a pas de mot de passe » (B30),
 * porté dans le corps d'erreur sous la clé `code`, comme les motifs de refus
 * d'envoi (`SEND_REFUSAL`). Le message peut être reformulé, le code non.
 */
export const PASSWORD_NOT_SET_CODE = 'PASSWORD_NOT_SET';

/**
 * 401 de `POST /v1/auth/login` sur un compte sans mot de passe (créé par
 * Google, ou rattaché à Google alors qu'il n'était pas confirmé). Volontairement
 * distinct de `INVALID_CREDENTIALS_MESSAGE` : « mot de passe incorrect »
 * enverrait l'utilisateur vers une réinitialisation inutile. Pas d'oracle
 * nouveau : `register` répond déjà 409 sur une adresse existante.
 */
export const PASSWORD_NOT_SET_LOGIN_MESSAGE =
  'Ce compte utilise la connexion Google. Cliquez sur « Continuer avec Google ».';

/** 400 de `POST /v1/auth/change-password` sur un compte sans mot de passe. */
export const PASSWORD_NOT_SET_CHANGE_MESSAGE =
  "Ce compte n'a pas de mot de passe : il utilise la connexion Google. Aucun mot de passe à changer.";
