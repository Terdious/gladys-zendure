# Zendure pour Gladys Assistant

Connectez vos batteries solaires **Zendure SolarFlow / Hyper** à Gladys
Assistant. L'intégration récupère la télémétrie en lecture seule (niveau de
batterie, puissances de charge/décharge, sortie maison et production solaire)
depuis le cloud Zendure et — en option — directement depuis le **broker MQTT
local** de chaque appareil, pour des mises à jour rapides et résilientes
hors-ligne, avec repli cloud automatique.

## Prérequis

- Un **compte Zendure**, avec vos batteries déjà installées et en ligne dans
  l'application Zendure.
- Gladys Assistant **5.1 ou plus récent**.

## Modèles pris en charge

SolarFlow 800, SolarFlow 800 Pro, SolarFlow 1600, SolarFlow 2400,
SolarFlow 2400 AC, SolarFlow 2400 Pro et Hyper 2000 (expérimental — mapping de
télémétrie à confirmer par un testeur de la communauté).

## Fonctionnalités

Chaque batterie est créée avec dix fonctionnalités en lecture seule, dans les
catégories énergie de Gladys (graphiques énergie, historique, tableaux de
bord) :

| Fonctionnalité               | Catégorie Gladys                | Unité |
| ---------------------------- | ------------------------------- | ----- |
| Niveau de batterie           | Batterie de stockage            | %     |
| Puissance de charge          | Batterie de stockage            | W     |
| Puissance de décharge        | Batterie de stockage            | W     |
| Puissance vers la maison     | Capteur de sortie maison        | W     |
| Puissance d'entrée solaire   | Capteur de production d'énergie | W     |
| Énergie chargée              | Batterie de stockage            | kWh   |
| Énergie déchargée            | Batterie de stockage            | kWh   |
| Énergie vers la maison       | Capteur de sortie maison        | kWh   |
| Énergie solaire              | Capteur de production d'énergie | kWh   |
| Énergie restante en batterie | Batterie de stockage            | kWh   |

Zendure ne remonte que des puissances : les quatre fonctionnalités
d'**énergie** (kWh) sont calculées par l'intégration, qui cumule chaque
puissance dans le temps. Ce sont des index cumulés, sauvegardés dans le volume
de données de l'intégration pour qu'un redémarrage ne les remette pas à zéro ;
un silence de plus de 5 minutes (batterie hors ligne, broker coupé) est écarté
plutôt que deviné. Gladys transforme l'index d'**énergie solaire** en
graphiques de production. L'**énergie restante** est le niveau de batterie
multiplié par la capacité des packs que la batterie déclare (AB1000, AB2000,
AB3000, packs intégrés) ; elle reste vide tant que la batterie n'a pas envoyé
la liste de ses packs.

Depuis la version 1.3.0, le niveau de batterie est celui d'une **batterie de
stockage**, et non la pile d'un appareil à remplacer : Gladys ne compte plus
votre batterie domestique dans ses alertes de batterie faible. Une batterie
créée avec une version précédente garde ses anciennes catégories tant que vous
n'appliquez pas la nouvelle définition : dans l'onglet **Découverte**, cliquez
sur **Mettre à jour** sur la batterie (marquée **Déjà ajouté**). Les
fonctionnalités sont mises à jour sur place : leur historique, les scènes et
les tableaux de bord sont conservés. Ce même **Mettre à jour** ajoute les
fonctionnalités d'énergie à une batterie créée avant la version 1.5.0.

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
5. (Optionnel) Choisissez la langue des **Noms des fonctionnalités** (anglais par
   défaut) : elle s'applique aux batteries que vous créez ensuite.
6. Cliquez sur **Enregistrer la configuration**. Vos batteries apparaissent dans
   l'onglet **Découverte**, prêtes à être ajoutées.

### MQTT local (recommandé si vous l'utilisez)

Quand vous activez le MQTT local dans l'application Zendure (mode développeur),
chaque appareil publie sa télémétrie sur un broker local de votre réseau.
Activer le **MQTT local (zenSDK)** dans Gladys fait lire l'intégration depuis ce
broker :

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

## Pilotage depuis les scènes

Gladys n'a pas encore de fonctionnalité de consigne pour une batterie : les
batteries se pilotent depuis les **scènes** (et depuis le widget du tableau de
bord). Dans une scène, ajoutez une action de la catégorie **Intégrations**.

| Action                           | Effet                                                       |
| -------------------------------- | ----------------------------------------------------------- |
| **Régler la limite de sortie**   | Puissance maximale fournie à la maison (W)                  |
| **Régler la limite de charge**   | Puissance maximale tirée du réseau, charge AC (W)           |
| **Régler le mode AC**            | Charge depuis le réseau, ou décharge vers la maison         |
| **Régler les niveaux de charge** | Cible de charge (70-100 %) et plancher de décharge (0-50 %) |

L'intégration protège la batterie :

- une limite est plafonnée à la puissance nominale de la batterie (par ex.
  800 W en sortie sur une SolarFlow 800 Pro) ;
- les limites de puissance sont envoyées en « mode intelligent », gardées en
  mémoire au lieu d'être écrites dans la flash de la batterie (des changements
  fréquents l'useraient) ;
- un même réglage ne peut pas changer plus d'une fois toutes les 3 s (limites
  de puissance) ou 30 s (mode AC, niveaux de charge) : une scène qui essaie
  plus tôt échoue en indiquant le délai à attendre ;
- une valeur déjà appliquée par la batterie n'est pas renvoyée (la sortie
  d'action **Commande envoyée** vaut alors faux) ;
- les niveaux de charge sont refusés tant que la batterie n'a pas remonté les
  siens (leur échelle diffère selon les firmwares).

La commande passe par le broker qui sert actuellement la batterie (local ou
cloud) ; la nouvelle valeur apparaît avec la remontée suivante de la batterie.

Le déclencheur **Joignabilité d'une batterie** lance une scène quand une
batterie ne remonte plus rien sur aucune source, ou remonte à nouveau (mode
MQTT local). Ses variables donnent le nom de la batterie, le nouvel état et la
source de télémétrie.

## Un seul consommateur cloud par compte Zendure

Zendure n'autorise **qu'un seul consommateur cloud par compte** à la fois. Si
une autre application utilise la connexion cloud du même compte (Home Assistant,
une seconde instance Gladys…), les deux se disputent la connexion et la
télémétrie devient intermittente. Privilégiez le **MQTT local** pour tout second
consommateur — le broker local n'a pas cette limite. L'intégration avertit une
fois dans ses journaux quand elle détecte ce phénomène de reprise de connexion.

## Mettre à jour l'intégration

**Installée depuis le catalogue** (le cas habituel) : Gladys consulte
régulièrement le store. Quand une nouvelle version sort, l'intégration affiche
un badge **« Mise à jour disponible »** (également compté à côté de
**Intégrations** dans le menu), et son onglet **Supervision** indique la version
proposée, avec un lien vers ses notes de version. Cliquez sur **Mettre à jour** :
Gladys récupère la nouvelle image **et** applique le nouveau manifest — les
nouveaux champs de configuration apparaissent d'eux-mêmes, il n'y a rien à
recoller. Votre configuration et vos appareils sont conservés.

Gladys peut mettre jusqu'à environ une heure et demie à voir une nouvelle
version (rafraîchissement de l'index du store). **« Forcer la mise à jour »**
vérifie immédiatement : il lit la dernière version publiée et récupère son
image.

**Installée en mode développeur** (manifest collé à la main) : **« Forcer la
mise à jour »** ne fait que récupérer à nouveau l'image du tag installé, et la
version affichée comme les champs de configuration proviennent du manifest
collé — recollez le manifest à jour pour récupérer les nouveaux champs.

## Dépannage

- **Une batterie n'est pas découverte.** Ouvrez l'onglet **Journaux** : une
  ligne `Unsupported Zendure model skipped: productModel "..."` donne le nom de
  modèle exact renvoyé par le cloud Zendure. Ouvrez une issue sur
  [gladys-zendure](https://github.com/Terdious/gladys-zendure/issues) avec ce
  nom, pour que le modèle soit ajouté.
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
  l'intégration dans son onglet **Journaux** (ou `docker logs` sur l'hôte). Chaque
  changement de source de télémétrie est journalisé sur une ligne `telemetry:`.
