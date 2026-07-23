# Zendure pour Gladys Assistant

Connectez vos batteries solaires **Zendure SolarFlow / Hyper** à Gladys
Assistant. L'intégration récupère la télémétrie en lecture seule (niveau de
batterie, puissances de charge/décharge, sortie maison et production solaire)
depuis le cloud Zendure et — en option — directement depuis le **broker MQTT
local** de chaque appareil, pour des mises à jour rapides et résilientes
hors-ligne, avec repli cloud automatique.

## Modèles pris en charge

SolarFlow 800, SolarFlow 800 Pro, SolarFlow 1600, SolarFlow 2400,
SolarFlow 2400 AC, SolarFlow 2400 Pro et Hyper 2000 (expérimental — mapping de
télémétrie à confirmer par un testeur de la communauté).

## Obtenir votre clé cloud Zendure

L'intégration s'authentifie auprès du cloud Zendure avec une **clé
d'autorisation** (un jeton base64) que vous générez une fois depuis
l'application mobile Zendure :

1. Ouvrez l'application **Zendure** et connectez-vous à votre compte.
2. Rendez-vous dans la section développeur / intégration Home Assistant de
   l'application et générez (ou copiez) votre **clé d'autorisation** (aussi
   appelée « clé HA »).
3. Copiez cette clé.

> La clé est un secret lié à votre compte Zendure : gardez-la privée. Gladys la
> stocke chiffrée et ne la journalise jamais.

## Configuration

1. Ouvrez l'onglet **Configuration** de l'intégration dans Gladys.
2. Collez votre clé dans **Clé cloud d'autorisation Zendure**.
3. Réglez l'**Intervalle de rafraîchissement** (secondes) — à quelle fréquence
   la télémétrie est rafraîchie en l'absence de mise à jour temps réel. La
   valeur par défaut (30 s) convient.
4. (Optionnel) Activez le **MQTT local (zenSDK)** — voir ci-dessous.
5. **Enregistrez.** Vos batteries apparaissent dans l'onglet **Découverte**,
   prêtes à être ajoutées.

### MQTT local (recommandé si vous l'utilisez)

Quand vous activez le MQTT local dans l'application Zendure (mode développeur),
chaque appareil publie sa télémétrie sur un broker local de votre réseau.
Activer **MQTT local** dans Gladys fait lire l'intégration depuis ce broker :

- **Plus rapide** : les valeurs locales se mettent à jour toutes les 1 à 3 s au
  lieu d'environ 30 s via le cloud.
- **Résilient** : la télémétrie continue pendant une panne du cloud Zendure ou
  d'internet.
- **Repli automatique** : si un appareil devient muet sur le broker local,
  l'intégration bascule seule sur le cloud, puis revient au local dès que les
  messages locaux reprennent — sans aucune action.

## Macarons de transport

Chaque appareil affiche un macaron indiquant **comment il est actuellement
joint** :

- **Local** (vert) — servi par son broker MQTT local (nominal quand le MQTT
  local est activé).
- **Cloud** (bleu) — servi par le cloud Zendure (nominal quand le MQTT local est
  désactivé).
- **Cloud + point orange (dégradé)** — l'appareil _devrait_ être local mais est
  temporairement sur le repli cloud (son broker local est devenu muet). Survolez
  le macaron pour la raison. Cela disparaît de soi-même quand l'appareil reprend
  en local.
- **Injoignable** (rouge) — le cloud Zendure signale l'appareil hors ligne, ou
  il est muet sur toutes les sources.

## Un seul consommateur cloud par compte Zendure

Zendure n'autorise **qu'un seul consommateur cloud par compte** à la fois. Si
une autre application utilise la connexion cloud du même compte (Home Assistant,
une seconde instance Gladys…), les deux se disputent la connexion et la
télémétrie devient intermittente. Privilégiez le **MQTT local** pour tout second
consommateur — le broker local n'a pas cette limite. L'intégration avertit une
fois dans ses journaux quand elle détecte ce phénomène de reprise de connexion.

## Dépannage

- **Un appareil n'affiche aucune valeur (ou est plus lent que les autres) alors
  que les autres fonctionnent.** Vérifiez son macaron de transport. S'il est
  passé en **Cloud (dégradé)** alors que le MQTT local est activé, son firmware
  a peut-être cessé silencieusement de publier en local. Dans l'application
  Zendure, basculez le **contrôle MQTT de cet appareil sur OFF**, enregistrez,
  puis de nouveau **ON** — il reprend la publication en moins d'une minute.
  L'intégration bascule sur le cloud entre-temps et revient au local
  automatiquement.
- **`Too Many Requests` dans les journaux.** L'intégration cadence ses mises à
  jour sous la limite du cœur Gladys et se régule au besoin ; des rafales
  occasionnelles sont sans conséquence. Un flot persistant vient généralement
  d'une **seconde instance de l'intégration** (par ex. un conteneur prod et un
  conteneur test côte à côte) qui partagent le même budget du cœur — n'en gardez
  qu'un.
- **Tout est muet juste après la configuration.** Vérifiez que la clé cloud est
  correcte : une clé invalide ou expirée affiche un statut « Le cloud Zendure
  est injoignable ou la clé cloud est invalide » sur l'écran de configuration.
- **Détail complet.** Définissez `LOG_LEVEL=debug` et lisez les journaux de
  l'intégration depuis l'interface Gladys (ou `docker logs` sur l'hôte). Chaque
  changement de source de télémétrie est journalisé sur une ligne `telemetry:`.
