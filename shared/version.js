// Version de railsbox, telle qu'elle apparaît dans une sandbox publiée.
//
// POURQUOI ELLE DOIT ÊTRE VISIBLE QUELQUE PART. Une sandbox est construite
// ailleurs et à un autre moment que le dépôt qui l'a produite : le mainteneur
// épingle `@main` ou un tag, la démonstration vit ensuite des semaines. Quand
// elle se comporte mal, la première question est « quelle version l'a
// fabriquée ? » — et sans réponse, il n'y a rien à comparer.
//
// La coquille l'affichait autrefois dans son en-tête. La refonte du 19/08/2026
// l'a retirée sans le vouloir, en faisant de l'application le sujet du titre :
// bon pour le visiteur, mauvais pour le diagnostic. Elle revient donc dans le
// JOURNAL, qui est la surface de diagnostic — replié par défaut sur une sandbox
// publiée, donc invisible pour qui vient juste essayer l'application.
//
// Un test vérifie qu'elle ne diverge pas de package.json : deux versions qui se
// contredisent valent moins que pas de version du tout.
export const VERSION_RAILSBOX = "2.3.0";
