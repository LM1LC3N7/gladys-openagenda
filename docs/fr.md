# OpenAgenda

**Intégration non officielle**, sans lien avec OpenAgenda. Jamais testée avec une
vraie clé OpenAgenda : le format des réponses vient de la documentation officielle
de l’API v2 (developers.openagenda.com, lue le 2026-11-14 ; l’API répondait alors
403 sans clé, comme documenté). Les réponses des tests sont inventées.

Les agendas culturels publiés sur [OpenAgenda](https://openagenda.com) (concerts,
expositions, spectacles, animations de votre ville…) deviennent des calendriers
Gladys : vue Calendrier, déclencheur de scène « Un événement arrive », actions de
scène et assistant, comme un calendrier CalDAV.

## Ce qu’il faut

- Un compte OpenAgenda gratuit et sa **clé publique** (`oa_pk_…`), dans
  [les paramètres du compte](https://openagenda.com/settings/apiKey). Une clé
  secrète (`oa_sk_…`) est refusée : elle permet d’écrire dans vos agendas, et
  l’intégration ne fait que lire.
- Gladys 5.3.0 ou plus récent.

## Configuration (administrateur)

1. Onglet **Configuration** : collez la clé publique. Elle est gardée par Gladys
   dans sa base, jamais réaffichée, envoyée seulement à OpenAgenda (en-tête
   `key`, jamais dans une adresse).
2. Réglages facultatifs :
   - **Intervalle de rafraîchissement** : chaque agenda est relu toutes les 6 h
     par défaut (2 à 24 h).
   - **Jours à venir** : 60 jours par défaut (7 à 365). Les événements de la
     veille restent un jour, puis disparaissent.
   - **Créneaux par agenda** : 500 par défaut (50 à 2 000), les plus proches
     d’abord. Un événement sur plusieurs dates compte un créneau par date.
3. **Tester la clé** : une petite requête à OpenAgenda ; la réponse liste les
   agendas suivis et la licence de leurs données.

## Vos agendas (chaque utilisateur)

Dans le bloc **Mes calendriers** de la page de l’intégration, chaque utilisateur
active l’intégration pour lui-même (c’est son accord) et indique :

- **Agendas** : jusqu’à 10, séparés par des virgules : le lien de l’agenda
  (`https://openagenda.com/agenda-de-ma-ville`), son nom court (la fin du lien)
  ou son numéro (`https://openagenda.com/agendas/12345678`).
- **Ville** (facultatif) : seulement les événements de cette ville, écrite comme
  OpenAgenda l’écrit (champ « commune » des lieux). Une ville illisible (signes
  autres que lettres, nombres, espace, apostrophe, point, tiret, parenthèses) :
  rien n’est lu ni changé pour ce compte tant qu’elle n’est pas corrigée.

Chaque agenda devient un calendrier **privé** de cet utilisateur. Pour qu’il soit
vu de tout le foyer et puisse déclencher des scènes, partagez-le (interrupteur
« Partagé »). L’interrupteur « Synchroniser » le vide et l’arrête ; remis, il est
rempli de nouveau depuis la dernière lecture, sans nouvelle demande à OpenAgenda.
Retirer un agenda de la liste supprime son calendrier (une fois qu’OpenAgenda a
répondu pour chaque entrée de la liste).

## Ce qui est lu

- Les événements **publiés** des agendas, dans la langue de l’utilisateur
  (français par défaut), de la veille jusqu’à l’horizon réglé. Chaque date d’un
  événement est un événement Gladys (début, fin, lieu, lien vers OpenAgenda).
- Écartés : les événements **annulés** et **reportés**. Marqués : « Complet : »
  et « En ligne : ». Un horaire sans fuseau, une fin avant le début ou un créneau
  de plus de 48 h ne sont pas lus.
- Un événement retiré de l’agenda disparaît de Gladys à la lecture suivante.

Rythme : un agenda est lu une fois par intervalle, toutes ses pages d’affilée,
une requête à la fois, 2 s au moins entre deux. Après un échec : nouvel essai
5 min, 15 min, 30 min, 1 h plus tard, puis à l’intervalle ; un agenda introuvable
(404) attend directement l’intervalle. Les textes sont nettoyés (balises HTML,
entités, caractères invisibles ou d’inversion d’écriture retirés). Un événement
vu deux fois (pages qui se recouvrent) ne compte qu’une fois. Quand le plafond de
créneaux est atteint avant la fin des pages, les événements de la veille sont lus
à part (l’API les range en dernier). Un redémarrage, une
reconnexion, un nouveau compte qui suit un agenda déjà lu ou un interrupteur ne
relancent pas de lecture : la dernière lecture, gardée dans `/data`, est
republiée. Deux utilisateurs qui suivent le même agenda dans la même langue et
la même ville partagent la même lecture.

## Licence des données

La licence est fixée par chaque éditeur, **événement par événement** (champ
`rights` de l’API) : le plus souvent la **Licence Ouverte / Etalab 2.0**, qui
permet la réutilisation, y compris commerciale, en citant la source et la date de
mise à jour. L’intégration l’affiche donc :

- dans la description de **chaque événement** : « Source : <éditeur> via
  OpenAgenda, licence <licence>, mis à jour le <date> » (« licence non indiquée »
  quand l’éditeur n’en donne pas) ;
- dans la description de **chaque calendrier** : les licences et les sources vues
  à la dernière lecture ;
- dans la réponse du bouton **Tester la clé**, agenda par agenda.

Vérifiez la licence d’un agenda avant de réutiliser ses données hors de Gladys :
les conditions sont sur <https://developers.openagenda.com/licence>. L’intégration
lit l’API `https://api.openagenda.com/v2` ; rien n’est embarqué dans l’image.

## Ce que l’intégration ne fait pas

- Elle n’écrit jamais dans OpenAgenda (lecture seule).
- Elle ne lit pas les agendas privés que la clé ne peut pas voir : l’agenda est
  marqué « non lisible avec cette clé », les autres continuent.
- Pas d’événement sur la journée entière : chaque créneau garde ses heures.

## État et pannes

L’onglet de l’intégration affiche : le nombre d’agendas suivis et lus, la date de
la dernière lecture, les agendas en erreur et la raison, les comptes à corriger
(entrée qui n’est pas un agenda, agenda introuvable, ville illisible ; le texte
saisi n’est jamais réaffiché), et une pause éventuelle.

- **Clé refusée** (401 ou 403 sur la liste des agendas, la route propre à la
  clé) : plus aucune demande automatique, même après un redémarrage, jusqu’à une
  nouvelle clé ou un clic réussi sur **Tester la clé**. Un 403 sur un seul agenda
  n’est pas un refus de la clé.
- **429 ou 5xx** : toutes les demandes s’arrêtent le temps indiqué par
  `Retry-After` (1 min à 6 h), sinon 10 min, puis 20, 40… jusqu’à 6 h ; des refus
  à la suite allongent la pause même avec un `Retry-After` court ; elle est gardée
  dans `/data`.
- **Lecture interrompue** (réseau, réponse illisible ou de plus de 6 Mo) : rien
  n’est envoyé à Gladys, le calendrier garde la lecture précédente.
- **Gladys** accepte 30 écritures de calendrier par minute : l’intégration en fait
  25 au plus et, sur un refus 429, attend une minute puis réécrit (3 fois au plus).
  Un calendrier que Gladys n’a pas pris en entier est renvoyé depuis la dernière
  lecture (sans demande à OpenAgenda) 5, 15, 30 min puis toutes les heures, jusqu’à
  ce qu’il passe. Une lecture qui ne change rien n’écrit rien ; une reconnexion à
  Gladys renvoie tout une fois.
- **`/data` illisible** : rien n’est demandé à OpenAgenda, relecture toutes les
  10 s. Le fichier est écrit sous 16 Mo (relu jusqu’à 32 Mo) : au-delà, les
  lectures les plus anciennes restent en mémoire seulement (leurs calendriers
  gardent leurs événements). **`/data` non inscriptible** : aucune lecture (un redémarrage ne saurait
  pas qu’elle a eu lieu).
