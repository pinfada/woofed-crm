# woofed-crm — démonstration jouable

[![Try with railsbox](https://pinfada.github.io/woofed-crm/badge.svg)](https://pinfada.github.io/woofed-crm/)

**→ [Ouvrir la démonstration](https://pinfada.github.io/woofed-crm/)**

Cette branche ne contient que la démonstration publiée. Le code de l'application vit sur la branche par défaut de ce dépôt.

## Ce que vous ouvrez

Une application Rails complète — Puma, sa base de données, ses gems natives —
qui tourne **entièrement dans votre navigateur**, dans une machine virtuelle
Linux i386 émulée. Aucun serveur n'est sollicité : ce que vous voyez s'exécute
sur votre machine, et ce que vous saisissez ne quitte pas votre onglet.

- **Premier chargement** : de trente secondes à deux minutes selon votre
  processeur. Les visites suivantes repartent d'un instantané mis en cache.
- **Votre copie est jetable** : chaque visiteur reçoit la sienne, personne ne
  voit celle d'un autre, et un rechargement la remet à zéro.
- **Ce n'est pas un environnement de production** : pas de réseau sortant, pas
  de WebSockets, et la vitesse est celle d'une émulation.

## Sous le capot

Publié par [railsbox](https://github.com/pinfada/railsbox), qui construit la
sandbox depuis une action GitHub et la sert en fichiers statiques. Le système de
base est mutualisé entre toutes les sandboxes : ce dépôt n'héberge que
l'application.

*Cette page est régénérée à chaque publication.*
