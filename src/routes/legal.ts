import { Router } from 'express';

export const legalRouter = Router();

const CONTACT = 'jivinigaspa@gmail.com';

const page = (title: string, body: string) => `<!DOCTYPE html>
<html lang="fr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} - Saint-Jude</title>
<style>body{font-family:Arial,sans-serif;max-width:760px;margin:40px auto;padding:0 16px;line-height:1.6;color:#222}h1{font-size:26px}h2{font-size:19px;margin-top:28px}</style>
</head><body>${body}</body></html>`;

legalRouter.get('/confidentialite', (_req, res) => {
  res.type('html').send(page('Politique de confidentialité', `
<h1>Politique de confidentialité</h1>
<p>Dernière mise à jour : 12 novembre 2026</p>
<p>Saint-Jude est une application de gestion de transport maritime (réservations, trajets, caisse, bateaux) à Madagascar.</p>
<h2>1. Données collectées</h2>
<ul><li>Nom, numéro de téléphone et e-mail fournis lors de la création de compte ou d'une réservation.</li>
<li>Informations de réservation (trajets, marchandises, paiements).</li>
<li>Messages envoyés à notre numéro WhatsApp et nos réponses.</li></ul>
<h2>2. Utilisation</h2>
<ul><li>Traiter et suivre vos réservations.</li>
<li>Vous envoyer des notifications par WhatsApp ou e-mail.</li>
<li>Répondre à vos questions sur les voyages et tarifs via un assistant automatisé.</li></ul>
<h2>3. Partage</h2>
<p>Nous ne vendons pas vos données. Elles sont traitées par nos prestataires techniques (hébergement, base de données, WhatsApp Business Platform de Meta) uniquement pour fournir le service.</p>
<h2>4. Conservation et sécurité</h2>
<p>Les données sont conservées le temps nécessaire au service et protégées par des accès restreints et des connexions chiffrées.</p>
<h2>5. Vos droits</h2>
<p>Vous pouvez demander l'accès, la correction ou la suppression de vos données. Voir <a href="/suppression-donnees">la page de suppression des données</a>.</p>
<h2>6. Contact</h2>
<p>${CONTACT}</p>`));
});

legalRouter.get('/suppression-donnees', (_req, res) => {
  res.type('html').send(page('Suppression des données', `
<h1>Suppression de vos données</h1>
<p>Pour supprimer vos données (compte, réservations, historique de messages WhatsApp), envoyez un e-mail à <b>${CONTACT}</b> avec l'objet « Suppression de données » et le numéro de téléphone associé à votre compte.</p>
<p>Nous traitons la demande dans un délai de 30 jours et vous confirmons la suppression par e-mail.</p>`));
});