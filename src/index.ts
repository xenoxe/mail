import "dotenv/config";
import express from "express";
import cors from "cors";
import nodemailer from "nodemailer";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";
import db, { dbQueries } from "./database.js";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import Stripe from "stripe";
import multer from "multer";

// Get __dirname equivalent for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Configuration CORS
// En production, remplacez par vos domaines réels
const allowedOrigins = process.env.ALLOWED_ORIGINS 
  ? process.env.ALLOWED_ORIGINS.split(',')
  : [
      'http://localhost:8080', // Dev local
      'http://localhost:5173', // Vite dev
      // Ajoutez vos domaines de production ici
      // 'https://votre-domaine.com',
      // 'https://www.votre-domaine.com'
    ];

app.use(cors({
  origin: (origin, callback) => {
    // Autoriser les requêtes sans origin (mobile apps, Postman, etc.)
    if (!origin) return callback(null, true);
    
    if (allowedOrigins.includes(origin) || process.env.NODE_ENV !== 'production') {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true
}));

// Configuration de multer pour l'upload d'images de variantes
const uploadsDir = path.join(process.cwd(), "public", "uploads", "variants");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
  console.log(`📁 Created uploads directory: ${uploadsDir}`);
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname);
    cb(null, 'variant-' + uniqueSuffix + ext);
  }
});

const upload = multer({ 
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB max
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Type de fichier non autorisé. Utilisez JPEG, PNG ou WebP.'));
    }
  }
});

// Helper pour enregistrer les logs d'audit
interface AuditLogParams {
  adminId?: number;
  adminUsername?: string;
  action: 'CREATE' | 'UPDATE' | 'DELETE' | 'LOGIN' | 'LOGOUT' | 'CONFIG_CHANGE' | 'STATUS_CHANGE' | 'EXPORT';
  entityType: 'user' | 'service' | 'booking' | 'quote' | 'config' | 'city' | 'auth' | 'audit_logs' | 'rgpd';
  entityId?: string | number | bigint;
  oldValue?: any;
  newValue?: any;
  description?: string;
  ipAddress?: string;
}

function createAuditLog(params: AuditLogParams) {
  try {
    const {
      adminId,
      adminUsername,
      action,
      entityType,
      entityId,
      oldValue,
      newValue,
      description,
      ipAddress
    } = params;

    dbQueries.createAuditLog.run(
      adminId || null,
      adminUsername || null,
      action,
      entityType,
      entityId ? String(entityId) : null,
      oldValue ? JSON.stringify(oldValue) : null,
      newValue ? JSON.stringify(newValue) : null,
      description || null,
      ipAddress || null
    );

    console.log(`📝 Log d'audit créé: ${action} ${entityType} ${entityId || ''}`);
  } catch (err) {
    console.error('❌ Erreur lors de la création du log d\'audit:', err);
  }
}

// Webhook Stripe doit être avant express.json() pour recevoir le body brut
app.post("/api/stripe/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  if (!stripe || !stripeWebhookSecret) {
    return res.status(503).json({ error: "Stripe non configuré" });
  }

  const sig = req.headers["stripe-signature"] as string;
  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, stripeWebhookSecret);
  } catch (err: any) {
    console.error("❌ Erreur de signature webhook Stripe:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Gérer les événements
  console.log(`📥 Webhook Stripe reçu: ${event.type}`);
  
  if (event.type === "checkout.session.completed") {
    const session = event.data.object as Stripe.Checkout.Session;
    const metadata = session.metadata;
    
    // Vérifier si c'est un paiement de test
    const isTestMode = session.livemode === false;
    const testModeConfig = dbQueries.getConfig.get("test_mode_enabled") as any;
    const testModeEnabled = testModeConfig?.value === "true";
    
    console.log(`📥 Session Stripe: ${session.id}`);
    console.log(`📥 Metadata complète:`, JSON.stringify(metadata, null, 2));
    console.log(`📥 Mode test: ${isTestMode ? "OUI" : "NON"}, Mode test activé: ${testModeEnabled ? "OUI" : "NON"}`);

    // Si c'est un paiement de test et que le mode test n'est pas activé, ignorer
    if (isTestMode && !testModeEnabled) {
      console.log(`⚠️ Paiement de test ignoré (mode test désactivé) pour la session ${session.id}`);
      return res.json({ received: true, ignored: true, reason: "test_mode_disabled" });
    }

    if (metadata?.type === "booking") {
      console.log(`📥 Type: booking détecté`);
      console.log(`📥 bookingId présent: ${!!metadata.bookingId}`);
      console.log(`📥 bookingName présent: ${!!metadata.bookingName}`);
      console.log(`📥 bookingPreferredDate présent: ${!!metadata.bookingPreferredDate}`);
      let bookingId: number | undefined;
      let booking: any;
      
      // Vérifier si c'est une réservation existante ou à créer
      if (metadata.bookingId) {
        // Ancien flux : réservation existante
        bookingId = typeof metadata.bookingId === 'string' ? parseInt(metadata.bookingId, 10) : metadata.bookingId;
        bookingId = typeof metadata.bookingId === 'string' ? parseInt(metadata.bookingId, 10) : metadata.bookingId;
        booking = dbQueries.getBookingById.get(bookingId) as any;
        
        if (!booking) {
          console.error(`❌ Réservation #${bookingId} introuvable dans la base de données`);
          return res.json({ received: true, error: `Réservation ${bookingId} introuvable` });
        }
        
        console.log(`📥 Réservation existante trouvée: statut actuel=${booking.status}, payment_status=${booking.payment_status}`);
        
        // Mettre à jour le paiement
        try {
          dbQueries.updateBookingPayment.run(
            session.payment_intent as string || null,
            session.id,
            "paid",
            bookingId
          );
          console.log(`✅ payment_status mis à jour à "paid" pour la réservation #${bookingId}${isTestMode ? " (MODE TEST)" : ""}`);
        } catch (err: any) {
          console.error(`❌ Erreur lors de la mise à jour du payment_status:`, err);
        }
        
        // Changer le statut de "awaiting_payment" à "pending" (validée)
        try {
          dbQueries.updateBookingStatus.run("pending", bookingId);
          console.log(`✅ Statut mis à jour de "awaiting_payment" à "pending" pour la réservation #${bookingId}${isTestMode ? " (MODE TEST)" : ""}`);
        } catch (err: any) {
          console.error(`❌ Erreur lors de la mise à jour du statut:`, err);
        }
      } else if (metadata.bookingName && metadata.bookingPreferredDate) {
        // Nouveau flux : créer la réservation après paiement
        console.log(`📥 Création de la réservation après paiement validé${isTestMode ? " (MODE TEST)" : ""}`);
        
        try {
          // Vérifier la limite de réservations par jour (priorité au service, puis limite générale)
          const maxBookingsConfig = dbQueries.getConfig.get("max_bookings_per_day") as any;
          let maxBookingsPerDay = parseInt(maxBookingsConfig?.value || "5", 10);
          
          // Si un serviceType est fourni, vérifier si ce service a une limite spécifique
          let useServiceLimit = false;
          if (metadata.bookingServiceType) {
            const serviceData = dbQueries.getServiceByServiceId.get(metadata.bookingServiceType) as any;
            if (serviceData && serviceData.max_bookings_per_day !== null && serviceData.max_bookings_per_day !== undefined) {
              maxBookingsPerDay = serviceData.max_bookings_per_day;
              useServiceLimit = true;
              console.log(`🎯 Webhook: Utilisation de la limite du service '${serviceData.name}': ${maxBookingsPerDay} réservations/jour`);
            } else {
              console.log(`ℹ️ Webhook: Utilisation de la limite générale: ${maxBookingsPerDay} réservations/jour`);
            }
          }
          
          // Compter les réservations: par service si limite spécifique, globales sinon
          console.log(`📊 Comptage des réservations: useServiceLimit=${useServiceLimit}, date=${metadata.bookingPreferredDate}, service=${metadata.bookingServiceType}`);
          const bookingsCount = useServiceLimit 
            ? dbQueries.countPaidBookingsByDateAndService.get(metadata.bookingPreferredDate, metadata.bookingServiceType)
            : dbQueries.countPaidBookingsByDate.get(metadata.bookingPreferredDate);
          const bookingsCountTyped = bookingsCount as any;
          const currentCount = bookingsCountTyped?.count || 0;
          console.log(`📊 Résultat comptage: ${currentCount}/${maxBookingsPerDay} réservations`);
          
          if (currentCount >= maxBookingsPerDay) {
            console.warn(`⚠️ Limite de réservations atteinte pour ${metadata.bookingPreferredDate}: ${currentCount}/${maxBookingsPerDay}`);
            // Ne pas créer la réservation, mais envoyer un email d'erreur
            if (smtpUser && smtpPass) {
              try {
                const transporter = nodemailer.createTransport({
                  host: smtpHost,
                  port: smtpPort,
                  secure: smtpPort === 465,
                  auth: { user: smtpUser, pass: smtpPass },
                });
                await transporter.sendMail({
                  from: smtpFrom,
                  to: smtpTo,
                  replyTo: metadata.bookingEmail,
                  subject: `⚠️ Réservation annulée - Date complète`,
                  text: `La réservation de ${metadata.bookingName} pour le ${metadata.bookingPreferredDate} n'a pas pu être créée car la date est complète. Le paiement sera remboursé.`,
                });
              } catch (emailErr) {
                console.error("⚠️ Erreur lors de l'envoi de l'email:", emailErr);
              }
            }
            return res.json({ received: true, error: "Date complète, réservation non créée" });
          }
          
          console.log(`✅ Webhook: Vérification limite OK, passage à la création de la réservation`);
          
          // Vérifier les conflits de réservation
          if (metadata.bookingPreferredTime) {
            const conflict = dbQueries.checkBookingConflict.get(metadata.bookingPreferredDate, metadata.bookingPreferredTime);
            if (conflict) {
              console.warn("⚠️ Conflit de réservation détecté");
              return res.json({ received: true, error: "Conflit de réservation détecté" });
            }
          }
          
          // Créer la réservation avec le statut "pending" (validée) et payment_status "paid"
          console.log(`📥 Tentative de création de la réservation avec les données:`, {
            name: metadata.bookingName,
            email: metadata.bookingEmail,
            phone: metadata.bookingPhone,
            city: metadata.bookingCity,
            date: metadata.bookingPreferredDate,
            time: metadata.bookingPreferredTime,
          });
          
          const result = dbQueries.insertBooking.run(
            metadata.bookingName,
            metadata.bookingEmail,
            metadata.bookingPhone,
            metadata.bookingCity,
            metadata.bookingAddress || null,
            metadata.bookingPostalCode || null,
            metadata.bookingServiceType,
            metadata.bookingBinCount || null,
            metadata.bookingPreferredDate,
            metadata.bookingPreferredTime || "09:00",
            metadata.bookingMessage || null,
            session.id, // stripe_session_id
            "paid", // payment_status
            metadata.bookingRgpdConsent === "true" ? 1 : 0,
            metadata.bookingMarketingConsent === "true" ? 1 : 0,
            new Date().toISOString(),
            null, // IP address (not available in webhook)
            metadata.variantId ? parseInt(metadata.variantId, 10) : null, // variant_id
            metadata.bookingSubscriptionContractConsent === "true" ? 1 : 0, // subscription_contract_consent
            metadata.bookingSubscriptionContractConsent === "true" ? new Date().toISOString() : null // subscription_contract_date
          );

          const newBookingId = Number((result as any).lastInsertRowid);
          bookingId = newBookingId;

          // Log d'audit (confirmation de paiement)
          createAuditLog({
            action: 'STATUS_CHANGE',
            entityType: 'booking',
            entityId: newBookingId,
            newValue: { payment_status: 'paid', stripe_session_id: session.id },
            description: `Paiement confirmé pour réservation: ${metadata.bookingName} - ${metadata.bookingCity}`,
            ipAddress: session.customer_details?.address?.country || null
          });
          
          console.log(`📥 Réservation créée avec ID: ${newBookingId}`);
          
          // Mettre le statut à "pending" (validée) directement
          dbQueries.updateBookingStatus.run("pending", bookingId);
          console.log(`📥 Statut mis à "pending"`);
          
          // Mettre à jour avec le payment_intent
          dbQueries.updateBookingPayment.run(
            session.payment_intent as string || null,
            session.id,
            "paid",
            bookingId
          );
          console.log(`📥 Payment status mis à "paid"`);
          
          booking = dbQueries.getBookingById.get(bookingId) as any;
          console.log(`✅ Réservation créée et validée #${bookingId}${isTestMode ? " (MODE TEST)" : ""}`);
          console.log(`📥 Réservation vérifiée:`, {
            id: booking?.id,
            name: booking?.name,
            status: booking?.status,
            payment_status: booking?.payment_status,
          });
        } catch (dbErr: any) {
          console.error(`❌ Erreur lors de la création de la réservation:`, dbErr);
          return res.json({ received: true, error: `Erreur lors de la création de la réservation: ${dbErr.message}` });
        }
      } else {
        console.error(`❌ Métadonnées de réservation incomplètes`);
        return res.json({ received: true, error: "Métadonnées de réservation incomplètes" });
      }
      
      // Vérifier que la mise à jour a bien fonctionné
      const updatedBooking = dbQueries.getBookingById.get(bookingId) as any;
      console.log(`📥 Réservation après traitement: statut=${updatedBooking.status}, payment_status=${updatedBooking.payment_status}`);
      
      console.log(`✅ Paiement confirmé et réservation validée #${bookingId}${isTestMode ? " (MODE TEST)" : ""}`);
      
      // Envoyer un email de confirmation après paiement
      if (smtpUser && smtpPass) {
        try {
          const transporter = nodemailer.createTransport({
            host: smtpHost,
            port: smtpPort,
            secure: smtpPort === 465,
            auth: {
              user: smtpUser,
              pass: smtpPass,
            },
          });

          const timeStr = booking.preferred_time && booking.preferred_time !== "09:00" && booking.preferred_time !== "00:00" ? ` à ${booking.preferred_time}` : "";
          const subject = `✅ RÉSERVATION CONFIRMÉE – ${booking.name} – ${booking.preferred_date}${timeStr}`;
          const text = [
            `Type: RÉSERVATION CONFIRMÉE (Paiement reçu)`,
            `Nom: ${booking.name}`,
            `Email: ${booking.email}`,
            `Téléphone: ${booking.phone}`,
            `Ville: ${booking.city}`,
            booking.address ? `Adresse: ${booking.address}` : undefined,
            booking.postal_code ? `Code postal: ${booking.postal_code}` : undefined,
            `Service: ${booking.service_type}`,
            booking.bin_count ? `Nombre de bacs: ${booking.bin_count}` : undefined,
            `Date: ${booking.preferred_date}`,
            booking.preferred_time && booking.preferred_time !== "09:00" && booking.preferred_time !== "00:00" ? `Heure: ${booking.preferred_time}` : undefined,
            "",
            `---`,
            `✅ Paiement reçu et réservation confirmée.`,
            `Session Stripe: ${session.id}`,
          ]
            .filter(Boolean)
            .join("\n");

          await transporter.sendMail({
            from: smtpFrom,
            to: smtpTo,
            replyTo: booking.email,
            subject,
            text,
          });

          console.log(`✅ Email de confirmation envoyé pour la réservation #${bookingId}`);
        } catch (emailErr) {
          console.error("⚠️ Erreur lors de l'envoi de l'email de confirmation:", emailErr);
        }
      }
    } else if (metadata?.type === "quote" && metadata?.quoteId) {
      const quoteId = parseInt(metadata.quoteId, 10);
      const quote = dbQueries.getQuoteById.get(quoteId) as any;
      
      if (quote) {
        dbQueries.updateQuotePayment.run(
          session.payment_intent as string || null,
          session.id,
          "paid",
          quoteId
        );
        console.log(`✅ Paiement confirmé pour le devis #${quoteId}`);
      }
    }
  }

  res.json({ received: true });
});

// Endpoint de test pour vérifier que le webhook est accessible
app.get("/api/stripe/webhook/test", (req, res) => {
  res.json({
    ok: true,
    message: "Webhook endpoint accessible",
    configured: !!stripe && !!stripeWebhookSecret,
    webhookUrl: `${baseUrl}/api/stripe/webhook`,
  });
});

// POST /api/stripe/verify-payment - Vérifier le statut d'un paiement (pour les paiements de test)
app.post("/api/stripe/verify-payment", express.json(), async (req, res) => {
  try {
    const { sessionId } = req.body;
    
    console.log("🔍 verify-payment appelé avec:", { sessionId, body: req.body });
    
    if (!sessionId) {
      console.error("❌ Paramètres manquants:", { sessionId: !!sessionId });
      return res.status(400).json({ ok: false, error: "sessionId est requis" });
    }

    if (!stripe) {
      return res.status(503).json({ ok: false, error: "Stripe non configuré" });
    }

    // Récupérer la session Stripe
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    
    // Vérifier si c'est un paiement de test
    const isTestMode = session.livemode === false;
    const testModeConfig = dbQueries.getConfig.get("test_mode_enabled") as any;
    const testModeEnabled = testModeConfig?.value === "true";
    
    console.log(`🔍 Vérification du paiement: session=${sessionId}`);
    console.log(`🔍 Session details:`, {
      payment_status: session.payment_status,
      status: session.status,
      livemode: session.livemode,
      isTestMode,
      testModeEnabled,
      metadata: session.metadata,
    });
    
    // Si c'est un paiement de test et que le mode test n'est pas activé, ne pas valider
    if (isTestMode && !testModeEnabled) {
      console.log(`⚠️ Paiement de test ignoré (mode test désactivé)`);
      return res.json({ 
        ok: false, 
        error: "Mode test désactivé. Les paiements de test ne sont pas acceptés.",
        sessionStatus: session.payment_status,
      });
    }

    // Vérifier le statut de la session
    // La session est considérée comme payée si :
    // - payment_status === "paid" OU
    // - status === "complete" (pour les paiements de test, le payment_status peut être null)
    const isPaid = session.payment_status === "paid" || session.status === "complete";
    
    console.log(`🔍 Session payée? ${isPaid} (payment_status=${session.payment_status}, status=${session.status})`);
    
    if (isPaid) {
      // Récupérer les métadonnées de la session
      const metadata = session.metadata;
      let booking: any;
      let finalBookingId: number;
      
      // Vérifier si c'est une réservation existante ou à créer
      if (metadata?.bookingId) {
        // Ancien flux : réservation existante
        finalBookingId = parseInt(metadata.bookingId, 10);
        booking = dbQueries.getBookingById.get(finalBookingId) as any;
        if (!booking) {
          return res.status(404).json({ ok: false, error: "Réservation non trouvée" });
        }
      } else if (metadata?.bookingName && metadata?.bookingPreferredDate) {
        // Nouveau flux : créer la réservation depuis les métadonnées
        try {
          // Vérifier la limite de réservations par jour (priorité au service, puis limite générale)
          const maxBookingsConfig = dbQueries.getConfig.get("max_bookings_per_day") as any;
          let maxBookingsPerDay = parseInt(maxBookingsConfig?.value || "5", 10);
          
          // Si un serviceType est fourni, vérifier si ce service a une limite spécifique
          let useServiceLimit = false;
          if (metadata.bookingServiceType) {
            const serviceData = dbQueries.getServiceByServiceId.get(metadata.bookingServiceType) as any;
            if (serviceData && serviceData.max_bookings_per_day !== null && serviceData.max_bookings_per_day !== undefined) {
              maxBookingsPerDay = serviceData.max_bookings_per_day;
              useServiceLimit = true;
              console.log(`🎯 Verify-payment: Utilisation de la limite du service '${serviceData.name}': ${maxBookingsPerDay} réservations/jour`);
            } else {
              console.log(`ℹ️ Verify-payment: Utilisation de la limite générale: ${maxBookingsPerDay} réservations/jour`);
            }
          }
          
          // Compter les réservations: par service si limite spécifique, globales sinon
          console.log(`📊 Verify-payment Comptage: useServiceLimit=${useServiceLimit}, date=${metadata.bookingPreferredDate}, service=${metadata.bookingServiceType}`);
          const bookingsCount = useServiceLimit 
            ? dbQueries.countPaidBookingsByDateAndService.get(metadata.bookingPreferredDate, metadata.bookingServiceType)
            : dbQueries.countPaidBookingsByDate.get(metadata.bookingPreferredDate);
          const bookingsCountTyped = bookingsCount as any;
          const currentCount = bookingsCountTyped?.count || 0;
          console.log(`📊 Verify-payment Résultat: ${currentCount}/${maxBookingsPerDay} réservations`);
          
          if (currentCount >= maxBookingsPerDay) {
            console.error(`❌ RÉSERVATION REFUSÉE - Limite atteinte: ${currentCount}/${maxBookingsPerDay}`);
            return res.json({ 
              ok: false, 
              error: "Date complète, réservation non créée",
              details: "La date sélectionnée est complète. Veuillez contacter le support pour un remboursement.",
            });
          }
          
          console.log(`✅ Verify-payment: Vérification limite OK, passage à la création de la réservation`);
          
          // Vérifier les conflits de réservation
          if (metadata.bookingPreferredTime) {
            const conflict = dbQueries.checkBookingConflict.get(metadata.bookingPreferredDate, metadata.bookingPreferredTime);
            if (conflict) {
              return res.json({ ok: false, error: "Conflit de réservation détecté" });
            }
          }
          
          // Créer la réservation
          const result = dbQueries.insertBooking.run(
            metadata.bookingName,
            metadata.bookingEmail,
            metadata.bookingPhone,
            metadata.bookingCity,
            metadata.bookingAddress || null,
            metadata.bookingPostalCode || null,
            metadata.bookingServiceType,
            metadata.bookingBinCount || null,
            metadata.bookingPreferredDate,
            metadata.bookingPreferredTime || "09:00",
            metadata.bookingMessage || null,
            session.id,
            "paid",
            metadata.bookingRgpdConsent === "true" ? 1 : 0,
            metadata.bookingMarketingConsent === "true" ? 1 : 0,
            new Date().toISOString(),
            null,
            metadata.variantId ? parseInt(metadata.variantId, 10) : null,
            metadata.bookingSubscriptionContractConsent === "true" ? 1 : 0,
            metadata.bookingSubscriptionContractConsent === "true" ? new Date().toISOString() : null
          );
          
          finalBookingId = Number(result.lastInsertRowid);
          dbQueries.updateBookingStatus.run("pending", finalBookingId);
          dbQueries.updateBookingPayment.run(
            session.payment_intent as string || null,
            session.id,
            "paid",
            finalBookingId
          );
          
          booking = dbQueries.getBookingById.get(finalBookingId) as any;
          console.log(`✅ Réservation créée et validée #${finalBookingId}${isTestMode ? " (MODE TEST)" : ""}`);
        } catch (dbErr: any) {
          console.error(`❌ Erreur lors de la création de la réservation:`, dbErr);
          return res.status(500).json({ ok: false, error: `Erreur lors de la création de la réservation: ${dbErr.message}` });
        }
      } else {
        return res.status(400).json({ ok: false, error: "Métadonnées de réservation incomplètes" });
      }

      // Si la réservation n'est pas déjà payée, la valider
      if (booking.payment_status !== "paid") {
        // Mettre à jour le paiement
        dbQueries.updateBookingPayment.run(
          session.payment_intent as string || null,
          session.id,
          "paid",
          finalBookingId
        );
        
        // Changer le statut de "awaiting_payment" à "pending" (validée)
        if (booking.status === "awaiting_payment") {
          dbQueries.updateBookingStatus.run("pending", finalBookingId);
        }
        
        console.log(`✅ Paiement vérifié et réservation validée #${finalBookingId}${isTestMode ? " (MODE TEST)" : ""}`);
        
        // Envoyer un email de confirmation si configuré (seulement si on vient de valider)
        if (smtpUser && smtpPass) {
          try {
            const transporter = nodemailer.createTransport({
              host: smtpHost,
              port: smtpPort,
              secure: smtpPort === 465,
              auth: {
                user: smtpUser,
                pass: smtpPass,
              },
            });

            const timeStr = booking.preferred_time && booking.preferred_time !== "00:00" ? ` à ${booking.preferred_time}` : "";
            const subject = `✅ RÉSERVATION CONFIRMÉE – ${booking.name} – ${booking.preferred_date}${timeStr}`;
            const text = [
              `Type: RÉSERVATION CONFIRMÉE (Paiement reçu)`,
              `Nom: ${booking.name}`,
              `Email: ${booking.email}`,
              `Téléphone: ${booking.phone}`,
              `Ville: ${booking.city}`,
              booking.address ? `Adresse: ${booking.address}` : undefined,
              booking.postal_code ? `Code postal: ${booking.postal_code}` : undefined,
              `Service: ${booking.service_type}`,
              booking.bin_count ? `Nombre de bacs: ${booking.bin_count}` : undefined,
              `Date: ${booking.preferred_date}`,
              booking.preferred_time && booking.preferred_time !== "00:00" ? `Heure: ${booking.preferred_time}` : undefined,
              "",
              `---`,
              `✅ Paiement reçu et réservation confirmée.`,
              `Session Stripe: ${session.id}`,
            ]
              .filter(Boolean)
              .join("\n");

            await transporter.sendMail({
              from: smtpFrom,
              to: smtpTo,
              replyTo: booking.email,
              subject,
              text,
            });

            console.log(`✅ Email de confirmation envoyé pour la réservation #${finalBookingId}`);
          } catch (emailErr) {
            console.error("⚠️ Erreur lors de l'envoi de l'email de confirmation:", emailErr);
          }
        }
        
        return res.json({ 
          ok: true, 
          message: "Paiement vérifié et réservation validée",
          bookingId: finalBookingId,
          testMode: isTestMode,
        });
      } else {
        console.log(`ℹ️ Réservation #${finalBookingId} déjà validée (payment_status=${booking.payment_status}, status=${booking.status})`);
        return res.json({ 
          ok: true, 
          message: "Paiement déjà validé",
          bookingId: finalBookingId,
        });
      }
    } else {
      console.log(`⚠️ Session non payée: payment_status=${session.payment_status}, status=${session.status}`);
      return res.json({ 
        ok: false, 
        error: "Paiement non complété",
        sessionStatus: session.payment_status,
        sessionComplete: session.status === "complete",
        details: {
          payment_status: session.payment_status,
          status: session.status,
          livemode: session.livemode,
        },
      });
    }
  } catch (err: any) {
    console.error("Erreur lors de la vérification du paiement:", err);
    return res.status(500).json({ ok: false, error: err.message || "Erreur serveur" });
  }
});

app.use(express.json());

// JWT Secret (à mettre dans les variables d'environnement en production)
const JWT_SECRET = process.env.JWT_SECRET || "changez-moi-en-production-12345";

// Stripe configuration (doit être avant le webhook)
const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
const stripe = stripeSecretKey ? new Stripe(stripeSecretKey, { apiVersion: "2025-12-15.clover" as any }) : null;
const baseUrl = process.env.BASE_URL || process.env.VITE_API_TARGET?.replace("/api", "") || "http://localhost:8080";

// Debug: Vérifier si Stripe est configuré
console.log("🔍 Vérification Stripe:", {
  hasSecretKey: !!stripeSecretKey,
  secretKeyLength: stripeSecretKey?.length || 0,
  secretKeyPrefix: stripeSecretKey?.substring(0, 7) || "non défini",
  hasWebhookSecret: !!stripeWebhookSecret,
  stripeInitialized: !!stripe
});

const smtpHost = process.env.SMTP_HOST || "ssl0.ovh.net";
const smtpPort = parseInt(process.env.SMTP_PORT || "465", 10);
const smtpUser = process.env.SMTP_USER;
const smtpPass = process.env.SMTP_PASS;
const smtpFrom = process.env.SMTP_FROM || smtpUser;
const smtpTo = process.env.SMTP_TO || smtpUser;

if (!smtpUser || !smtpPass) {
  // eslint-disable-next-line no-console
  console.warn("SMTP_USER/SMTP_PASS not set. Email sending will fail.");
}

// GET /api/config - Récupérer la configuration publique
app.get("/api/config", (req, res) => {
  try {
    const quotesConfig = dbQueries.getConfig.get("quotes_enabled") as any;
    const quotesEnabled = quotesConfig?.value === "true";
    const timeSelectionConfig = dbQueries.getConfig.get("time_selection_enabled") as any;
    const timeSelectionEnabled = timeSelectionConfig?.value !== "false"; // Par défaut true
    const languagesConfig = dbQueries.getConfig.get("languages_enabled") as any;
    const languagesEnabled = languagesConfig?.value !== "false"; // Par défaut true
    const contactPhoneConfig = dbQueries.getConfig.get("contact_phone") as any;
    const contactPhone = contactPhoneConfig?.value || "";
    const cities = dbQueries.getServiceCities.all() as any[];
    
    return res.json({
      ok: true,
      config: {
        quotesEnabled,
        timeSelectionEnabled,
        languagesEnabled,
        contactPhone,
        serviceCities: cities.map(c => ({
          id: c.id,
          name: c.city_name,
          postalCode: c.postal_code,
          cutoffDate: c.cutoff_date,
        })),
      },
    });
  } catch (err) {
    console.error("Erreur lors de la récupération de la config:", err);
    return res.status(500).json({ ok: false, error: "Erreur serveur" });
  }
});

// Fonction pour calculer le Nème jour du mois (ex: 3ème mercredi)
// Retourne un tableau de dates si weekNumber === 0 (toutes les semaines)
function getNthWeekdayOfMonth(year: number, month: number, weekNumber: number, weekday: number): Date[] {
  // weekNumber: 0=toutes les semaines, 1=premier, 2=deuxième, 3=troisième, 4=quatrième, 5=dernier
  // weekday: 0=dimanche, 1=lundi, ..., 6=samedi
  
  if (weekNumber === 0) {
    // Toutes les occurrences du jour dans le mois
    const dates: Date[] = [];
    const firstDay = new Date(year, month, 1);
    let date = new Date(firstDay);
    
    // Avancer jusqu'au premier jour correspondant
    while (date.getDay() !== weekday) {
      date.setDate(date.getDate() + 1);
    }
    
    // Ajouter toutes les occurrences de ce jour dans le mois
    while (date.getMonth() === month) {
      dates.push(new Date(date));
      date.setDate(date.getDate() + 7);
    }
    
    return dates;
  } else if (weekNumber === 5) {
    // Dernier occurrence du jour dans le mois
    const lastDay = new Date(year, month + 1, 0); // Dernier jour du mois
    let date = new Date(lastDay);
    
    // Reculer jusqu'au bon jour de la semaine
    while (date.getDay() !== weekday) {
      date.setDate(date.getDate() - 1);
    }
    return [date];
  } else {
    // Nème occurrence (1er, 2ème, 3ème, 4ème)
    const firstDay = new Date(year, month, 1);
    let date = new Date(firstDay);
    
    // Avancer jusqu'au premier jour correspondant
    while (date.getDay() !== weekday) {
      date.setDate(date.getDate() + 1);
    }
    
    // Ajouter les semaines nécessaires
    date.setDate(date.getDate() + (weekNumber - 1) * 7);
    
    // Vérifier qu'on est toujours dans le même mois
    if (date.getMonth() !== month) {
      return []; // Pas de Nème occurrence ce mois-ci
    }
    
    return [date];
  }
}

// GET /api/bookings/available-dates - Récupérer les dates complètes et les dates autorisées (publique)
app.get("/api/bookings/available-dates", (req, res) => {
  try {
    const { startDate, endDate, city, serviceType } = req.query;
    
    console.log("\n🌐 ========== REQUÊTE AVAILABLE-DATES ==========");
    console.log("📥 Paramètres reçus:");
    console.log("   - city:", city);
    console.log("   - serviceType:", serviceType, `(type: ${typeof serviceType})`);
    console.log("   - startDate:", startDate);
    console.log("   - endDate:", endDate);
    
    if (!startDate || !endDate) {
      return res.status(400).json({ ok: false, error: "startDate et endDate sont requis" });
    }

    // Récupérer la limite (priorité au service, puis limite générale)
    const maxBookingsConfig = dbQueries.getConfig.get("max_bookings_per_day") as any;
    let maxBookingsPerDay = parseInt(maxBookingsConfig?.value || "5", 10);
    let useServiceLimit = false;
    
    // Si un serviceType est fourni, vérifier si ce service a une limite spécifique
    if (serviceType) {
      const serviceData = dbQueries.getServiceByServiceId.get(serviceType) as any;
      if (serviceData && serviceData.max_bookings_per_day !== null && serviceData.max_bookings_per_day !== undefined) {
        maxBookingsPerDay = serviceData.max_bookings_per_day;
        useServiceLimit = true;
        console.log(`🎯 Utilisation de la limite du service '${serviceData.name}': ${maxBookingsPerDay} réservations/jour`);
      } else {
        console.log(`ℹ️ Utilisation de la limite générale: ${maxBookingsPerDay} réservations/jour`);
      }
    } else {
      console.log(`ℹ️ Pas de serviceType fourni, utilisation de la limite générale: ${maxBookingsPerDay} réservations/jour`);
    }
    
    // Utiliser les réservations payées pour vérifier la limite (seules les payées comptent pour la limite)
    // Filtrer par service si une limite spécifique est utilisée
    const paidBookingsByDate = useServiceLimit
      ? dbQueries.getPaidBookingsByDateRangeAndService.all(startDate, endDate, serviceType)
      : dbQueries.getPaidBookingsByDateRange.all(startDate, endDate);
    
    // Filtrer les dates complètes (basé sur les réservations payées uniquement)
    const fullDates = (paidBookingsByDate as any[])
      .filter((b: any) => {
        let count = 0;
        if (typeof b.count === 'number') {
          count = b.count;
        } else if (typeof b.count === 'bigint') {
          count = Number(b.count);
        } else if (typeof b.count === 'string') {
          count = parseInt(b.count, 10) || 0;
        }
        return count >= maxBookingsPerDay;
      })
      .map((b: any) => b.preferred_date);
    
    // Calculer les dates autorisées
    let allowedDates: string[] = [];
    let passageConfig: { passage1_week: number | null; passage1_day: number | null; passage2_week: number | null; passage2_day: number | null; } | null = null;
    let source = "";
    
    // PRIORITÉ 1 : Vérifier si le service a des jours de passage configurés
    if (serviceType) {
      console.log(`\n🔍 ÉTAPE 1 - Recherche du service avec service_id: "${serviceType}"`);
      const serviceData = dbQueries.getServiceByServiceId.get(serviceType) as any;
      
      if (serviceData) {
        console.log(`✅ Service trouvé: "${serviceData.name}"`);
        console.log(`   Données complètes:`, {
          id: serviceData.id,
          service_id: serviceData.service_id,
          name: serviceData.name,
          passage1_week: serviceData.passage1_week,
          passage1_day: serviceData.passage1_day,
          passage2_week: serviceData.passage2_week,
          passage2_day: serviceData.passage2_day,
        });
        
        const hasPassage1 = serviceData.passage1_week !== null && serviceData.passage1_week !== undefined;
        const hasPassage2 = serviceData.passage2_week !== null && serviceData.passage2_week !== undefined;
        console.log(`   ✓ Passage 1 configuré: ${hasPassage1} (week=${serviceData.passage1_week}, day=${serviceData.passage1_day})`);
        console.log(`   ✓ Passage 2 configuré: ${hasPassage2} (week=${serviceData.passage2_week}, day=${serviceData.passage2_day})`);
        
        if (hasPassage1 || hasPassage2) {
          passageConfig = {
            passage1_week: serviceData.passage1_week,
            passage1_day: serviceData.passage1_day,
            passage2_week: serviceData.passage2_week,
            passage2_day: serviceData.passage2_day,
          };
          source = `service '${serviceData.name}'`;
          console.log(`🎯 ✅ UTILISATION DE LA CONFIG DU SERVICE (PRIORITAIRE)`);
        } else {
          console.log(`⚠️ Service trouvé mais AUCUN jour de passage configuré`);
        }
      } else {
        console.log(`❌ Service non trouvé avec l'ID ${serviceType}`);
      }
    } else {
      console.log(`ℹ️ Pas de serviceType fourni dans la requête`);
    }
    
    // PRIORITÉ 2 : Utiliser les jours de passage de la ville si le service n'en a pas
    console.log(`\n🔍 ÉTAPE 2 - Vérification ville (passageConfig défini: ${passageConfig !== null})`);
    if (!passageConfig && city) {
      console.log(`   Recherche de la ville: "${city}"`);
      const cityData = dbQueries.checkServiceCity.get(city) as any;
      if (cityData && cityData.enabled) {
        console.log(`✅ Ville trouvée et activée`);
        console.log(`   Données:`, {
          city_name: cityData.city_name,
          passage1_week: cityData.passage1_week,
          passage1_day: cityData.passage1_day,
          passage2_week: cityData.passage2_week,
          passage2_day: cityData.passage2_day,
        });
        passageConfig = {
          passage1_week: cityData.passage1_week,
          passage1_day: cityData.passage1_day,
          passage2_week: cityData.passage2_week,
          passage2_day: cityData.passage2_day,
        };
        source = `ville '${city}'`;
        console.log(`📍 ✅ UTILISATION DE LA CONFIG DE LA VILLE (FALLBACK)`);
      } else {
        console.log(`❌ Ville non trouvée ou désactivée`);
      }
    } else if (passageConfig) {
      console.log(`⏭️ SKIP - Config service déjà définie`);
    } else if (!city) {
      console.log(`⏭️ SKIP - Pas de ville fournie`);
    }
    
    console.log(`\n📊 RÉSULTAT FINAL: source = "${source}"`);
    console.log("=================================================\n");
    
    // Calculer les dates autorisées basées sur la config (service ou ville)
    if (passageConfig) {
        const start = new Date(startDate as string);
        const end = new Date(endDate as string);
        
        // Parcourir tous les mois dans la plage
        const current = new Date(start);
        while (current <= end) {
          const year = current.getFullYear();
          const month = current.getMonth();
          
          // Passage 1
          if (passageConfig.passage1_week !== null && passageConfig.passage1_day !== null) {
            console.log(`📅 Calcul Passage 1 pour ${source}: semaine=${passageConfig.passage1_week}, jour=${passageConfig.passage1_day} (${year}-${month+1})`);
            const dates = getNthWeekdayOfMonth(year, month, passageConfig.passage1_week, passageConfig.passage1_day);
            console.log(`   Dates calculées (timezone ${new Date().getTimezoneOffset()} min):`, dates.map(d => {
              const y = d.getFullYear();
              const m = String(d.getMonth() + 1).padStart(2, '0');
              const day = String(d.getDate()).padStart(2, '0');
              const dateStr = `${y}-${m}-${day}`;
              const dayOfWeek = d.getDay();
              return `${dateStr} (getDay=${dayOfWeek})`;
            }));
            for (const date of dates) {
              if (date >= start && date <= end) {
                const y = date.getFullYear();
                const m = String(date.getMonth() + 1).padStart(2, '0');
                const day = String(date.getDate()).padStart(2, '0');
                const dateStr = `${y}-${m}-${day}`;
                if (!allowedDates.includes(dateStr)) {
                  allowedDates.push(dateStr);
                }
              }
            }
          }
          
          // Passage 2
          if (passageConfig.passage2_week !== null && passageConfig.passage2_day !== null) {
            console.log(`📅 Calcul Passage 2 pour ${source}: semaine=${passageConfig.passage2_week}, jour=${passageConfig.passage2_day} (${year}-${month+1})`);
            const dates = getNthWeekdayOfMonth(year, month, passageConfig.passage2_week, passageConfig.passage2_day);
            console.log(`   Dates calculées:`, dates.map(d => {
              const y = d.getFullYear();
              const m = String(d.getMonth() + 1).padStart(2, '0');
              const day = String(d.getDate()).padStart(2, '0');
              const dateStr = `${y}-${m}-${day}`;
              const dayOfWeek = d.getDay();
              return `${dateStr} (getDay=${dayOfWeek})`;
            }));
            for (const date of dates) {
              if (date >= start && date <= end) {
                const y = date.getFullYear();
                const m = String(date.getMonth() + 1).padStart(2, '0');
                const day = String(date.getDate()).padStart(2, '0');
                const dateStr = `${y}-${m}-${day}`;
                if (!allowedDates.includes(dateStr)) {
                  allowedDates.push(dateStr);
                }
              }
            }
          }
          
          // Passer au mois suivant
          current.setMonth(current.getMonth() + 1);
          current.setDate(1);
        }
      }
    
    return res.json({
      ok: true,
      fullDates, // Liste des dates complètes
      allowedDates: allowedDates.length > 0 ? allowedDates : null, // Dates spécifiques autorisées
    });
  } catch (err) {
    console.error("Erreur lors de la récupération des dates complètes:", err);
    return res.status(500).json({ ok: false, error: "Erreur serveur" });
  }
});

// POST /api/contact-general - Contact général (questions)
app.post("/api/contact-general", async (req, res) => {
  const { name, email, phone, message } = req.body || {};
  
  if (!name || !email || !message) {
    return res.status(400).json({ ok: false, error: "Missing required fields" });
  }

  try {
    const transporter = nodemailer.createTransport({
      host: smtpHost,
      port: smtpPort,
      secure: smtpPort === 465,
      auth: {
        user: smtpUser,
        pass: smtpPass,
      },
    });

    const subject = `💬 Nouveau message de contact – ${name}`;
    const text = [
      `Type: Message de contact`,
      `Nom: ${name}`,
      `Email: ${email}`,
      phone ? `Téléphone: ${phone}` : undefined,
      "",
      `Message:\n${message}`,
    ]
      .filter(Boolean)
      .join("\n");

    await transporter.sendMail({
      from: smtpFrom,
      to: smtpTo,
      replyTo: email,
      subject,
      text,
    });

    console.log("✅ Message de contact envoyé avec succès");
    return res.json({ ok: true });
  } catch (err) {
    console.error("❌ Erreur lors de l'envoi du message:", err);
    return res.status(500).json({ ok: false, error: "Email send failed" });
  }
});

// POST /api/contact - Demande de devis
app.post("/api/contact", async (req, res) => {
  const { name, email, phone, city, address, postalCode, serviceType, binCount, company, message, rgpdConsent, marketingConsent } = req.body || {};
  
  // Vérifier si les devis sont activés
  try {
    const quotesConfig = dbQueries.getConfig.get("quotes_enabled") as any;
    const quotesEnabled = quotesConfig?.value === "true";
    if (!quotesEnabled) {
      return res.status(403).json({ ok: false, error: "Les demandes de devis sont actuellement désactivées" });
    }

    // Vérifier que la ville est dans la liste autorisée
    const cityCheck = dbQueries.checkServiceCity.get(city);
    if (!cityCheck) {
      return res.status(400).json({ ok: false, error: "Nous n'intervenons pas encore dans cette ville" });
    }
  } catch (configErr) {
    console.error("Erreur lors de la vérification de la config:", configErr);
    // On continue quand même si la config n'est pas disponible
  }
  
  // Log de la requête reçue
  console.log("📧 Nouvelle demande de contact/devis reçue:", {
    name: name || "Non fourni",
    email: email || "Non fourni", 
    phone: phone || "Non fourni",
    city: city || "Non fourni",
    serviceType: serviceType || "Non fourni",
    binCount: binCount || "Non fourni",
    company: company || "Non fourni",
    messageLength: message ? message.length : 0,
    timestamp: new Date().toISOString()
  });

  if (!name || !email || !phone || !city || !serviceType) {
    console.log("❌ Champs manquants:", { name: !!name, email: !!email, phone: !!phone, city: !!city, serviceType: !!serviceType });
    return res.status(400).json({ ok: false, error: "Missing required fields" });
  }

  try {
    console.log("🔧 Configuration SMTP:", {
      host: smtpHost,
      port: smtpPort,
      secure: smtpPort === 465,
      user: smtpUser ? `${smtpUser.substring(0, 3)}***` : "Non défini",
      from: smtpFrom,
      to: smtpTo
    });

    const transporter = nodemailer.createTransport({
      host: smtpHost,
      port: smtpPort,
      secure: smtpPort === 465, // OVH SSL port
      auth: {
        user: smtpUser,
        pass: smtpPass,
      },
    });

    console.log("✅ Transporter SMTP créé avec succès");

    const subject = `Nouvelle demande de devis – ${name}`;
    const text = [
      `Type: Demande de devis`,
      `Nom: ${name}`,
      `Email: ${email}`,
      `Téléphone: ${phone}`,
      `Ville: ${city}`,
      `Service: ${serviceType}`,
      binCount ? `Nombre de bacs: ${binCount}` : undefined,
      company ? `Entreprise: ${company}` : undefined,
      "",
      message ? `Message:\n${message}` : undefined,
    ]
      .filter(Boolean)
      .join("\n");

    console.log("📝 Préparation de l'email:", {
      subject,
      from: smtpFrom,
      to: smtpTo,
      replyTo: email,
      textLength: text.length
    });

    const mailResult = await transporter.sendMail({
      from: smtpFrom,
      to: smtpTo,
      replyTo: email,
      subject,
      text,
    });

    console.log("✅ Email envoyé avec succès:", {
      messageId: mailResult.messageId,
      accepted: mailResult.accepted,
      rejected: mailResult.rejected,
      timestamp: new Date().toISOString()
    });

    // Sauvegarder dans la base de données
    try {
      const result = dbQueries.insertQuote.run(
        name,
        email,
        phone,
        city,
        address || null,
        postalCode || null,
        serviceType,
        binCount || null,
        message || null,
        rgpdConsent ? 1 : 0,
        marketingConsent ? 1 : 0,
        new Date().toISOString(),
        req.ip || null
      );
      console.log("✅ Demande de devis sauvegardée en BDD:", result.lastInsertRowid);
    } catch (dbErr) {
      console.error("⚠️ Erreur lors de la sauvegarde en BDD (email envoyé quand même):", dbErr);
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error("❌ Erreur lors de l'envoi de l'email:", {
      error: err,
      message: err instanceof Error ? err.message : "Erreur inconnue",
      stack: err instanceof Error ? err.stack : undefined,
      timestamp: new Date().toISOString()
    });
    return res.status(500).json({ ok: false, error: "Email send failed" });
  }
});

// Endpoint pour les réservations
app.post("/api/booking", async (req, res) => {
  const { name, email, phone, city, address, postalCode, serviceType, binCount, preferredDate, preferredTime, message, rgpdConsent, marketingConsent } = req.body || {};
  
  // Vérifier que la ville est dans la liste autorisée
  try {
    const cityCheck = dbQueries.checkServiceCity.get(city);
    if (!cityCheck) {
      return res.status(400).json({ ok: false, error: "Nous n'intervenons pas encore dans cette ville" });
    }
    
    // Vérifier la date limite de la ville (si renseignée)
    const cityCheckTyped = cityCheck as any;
    if (cityCheckTyped?.cutoff_date && preferredDate) {
      const cutoffDate = new Date(cityCheckTyped.cutoff_date);
      const requestedDate = new Date(preferredDate);
      
      if (requestedDate > cutoffDate) {
        return res.status(400).json({ 
          ok: false, 
          error: `Les réservations pour ${city} sont fermées au-delà du ${cutoffDate.toLocaleDateString('fr-FR')}`
        });
      }
    }
  } catch (configErr) {
    console.error("Erreur lors de la vérification de la ville:", configErr);
    // On continue quand même si la config n'est pas disponible
  }
  
  // Log de la requête reçue
  console.log("📅 Nouvelle réservation reçue:", {
    name: name || "Non fourni",
    email: email || "Non fourni", 
    phone: phone || "Non fourni",
    city: city || "Non fourni",
    serviceType: serviceType || "Non fourni",
    binCount: binCount || "Non fourni",
    preferredDate: preferredDate || "Non fourni",
    preferredTime: preferredTime || "Non fourni",
    messageLength: message ? message.length : 0,
    timestamp: new Date().toISOString()
  });

  // Vérifier si la sélection d'heure est activée
  const timeSelectionConfig = dbQueries.getConfig.get("time_selection_enabled") as any;
  const timeSelectionEnabled = timeSelectionConfig?.value !== "false";
  
  if (!name || !email || !phone || !city || !serviceType || !preferredDate || (timeSelectionEnabled && !preferredTime)) {
    console.log("❌ Champs manquants:", { 
      name: !!name, 
      email: !!email, 
      phone: !!phone, 
      city: !!city, 
      serviceType: !!serviceType,
      preferredDate: !!preferredDate,
      preferredTime: !!preferredTime,
      timeSelectionEnabled
    });
    return res.status(400).json({ ok: false, error: "Missing required fields" });
  }

  try {
    // Vérifier d'abord si la base de données est disponible
    if (!dbQueries) {
      console.error("❌ Base de données non initialisée");
      return res.status(500).json({ ok: false, error: "Base de données non disponible" });
    }

    console.log("🔧 Configuration SMTP:", {
      host: smtpHost,
      port: smtpPort,
      secure: smtpPort === 465,
      user: smtpUser ? `${smtpUser.substring(0, 3)}***` : "Non défini",
      from: smtpFrom,
      to: smtpTo
    });

    // Note: L'email de notification sera envoyé uniquement après confirmation du paiement via le webhook Stripe
    // Cela évite de notifier pour des réservations qui ne seront peut-être jamais payées
    console.log("📝 Réservation créée en attente de paiement - l'email sera envoyé après confirmation du paiement");

    // Sauvegarder dans la base de données AVANT de vérifier les conflits
    // (pour éviter les conflits avec les réservations en cours de traitement)
    try {
      // Vérifier la limite de réservations par jour (priorité au service, puis limite générale)
      // Note: Les réservations en attente de paiement ne comptent pas dans la limite
      const maxBookingsConfig = dbQueries.getConfig.get("max_bookings_per_day") as any;
      let maxBookingsPerDay = parseInt(maxBookingsConfig?.value || "5", 10);
      
      // Si un serviceType est fourni, vérifier si ce service a une limite spécifique
      let useServiceLimit = false;
      if (serviceType) {
        const serviceData = dbQueries.getServiceByServiceId.get(serviceType) as any;
        if (serviceData && serviceData.max_bookings_per_day !== null && serviceData.max_bookings_per_day !== undefined) {
          maxBookingsPerDay = serviceData.max_bookings_per_day;
          useServiceLimit = true;
          console.log(`🎯 Booking: Utilisation de la limite du service '${serviceData.name}': ${maxBookingsPerDay} réservations/jour`);
        } else {
          console.log(`ℹ️ Booking: Utilisation de la limite générale: ${maxBookingsPerDay} réservations/jour`);
        }
      }
      
      // Compter les réservations PAYÉES uniquement: par service si limite spécifique, globales sinon
      // Note: On ne compte que les réservations payées car les autres peuvent être annulées
      console.log(`📊 Booking Comptage: useServiceLimit=${useServiceLimit}, date=${preferredDate}, service=${serviceType}`);
      const bookingsCount = useServiceLimit 
        ? dbQueries.countPaidBookingsByDateAndService.get(preferredDate, serviceType)
        : dbQueries.countPaidBookingsByDate.get(preferredDate);
      const bookingsCountTyped = bookingsCount as any;
      const currentCount = bookingsCountTyped?.count || 0;
      console.log(`📊 Booking Résultat: ${currentCount}/${maxBookingsPerDay} réservations PAYÉES`);
      
      if (currentCount >= maxBookingsPerDay) {
        console.error(`❌ RÉSERVATION REFUSÉE - Limite atteinte: ${currentCount}/${maxBookingsPerDay}`);
        return res.status(409).json({ 
          ok: false, 
          error: "Désolé, cette date est complète. Veuillez choisir une autre date pour votre réservation." 
        });
      }

      console.log(`✅ Booking: Vérification limite OK, passage aux vérifications de conflit`);

      // Vérifier les conflits de réservation seulement si l'heure est fournie
      if (preferredTime) {
        const conflict = dbQueries.checkBookingConflict.get(preferredDate, preferredTime);
        if (conflict) {
          console.warn("⚠️ Conflit de réservation détecté");
          return res.status(409).json({ ok: false, error: "Cette date et heure sont déjà réservées" });
        }
      }

      // Insérer la réservation avec le statut "awaiting_payment" (en attente de paiement)
      // Le statut ne passera à "pending" qu'après paiement confirmé
      const result = dbQueries.insertBooking.run(
        name,
        email,
        phone,
        city,
        address || null,
        postalCode || null,
        serviceType,
        binCount || null,
        preferredDate,
        preferredTime || "09:00", // Valeur par défaut si l'heure n'est pas fournie
        message || null,
        null, // stripe_session_id (sera mis à jour après création de la session)
        "unpaid", // payment_status
        rgpdConsent ? 1 : 0,
        marketingConsent ? 1 : 0,
        new Date().toISOString(),
        req.ip || null,
        null // variant_id (ajouté pour correspondre au schéma)
      );

      const bookingId = (result as any).lastInsertRowid;

      // Log d'audit (création de réservation publique)
      createAuditLog({
        action: 'CREATE',
        entityType: 'booking',
        entityId: bookingId,
        newValue: { name, email, phone, city, serviceType, preferredDate, preferredTime },
        description: `Nouvelle réservation créée: ${name} - ${city} le ${preferredDate}`,
        ipAddress: req.ip || req.socket.remoteAddress
      });
      
      // Mettre le statut à "awaiting_payment" pour indiquer qu'on attend le paiement
      dbQueries.updateBookingStatus.run("awaiting_payment", result.lastInsertRowid);
      
      console.log("✅ Réservation sauvegardée en BDD (en attente de paiement):", result.lastInsertRowid);
      
      return res.json({ 
        ok: true, 
        bookingId: result.lastInsertRowid,
        message: "Réservation créée avec succès"
      });
    } catch (dbErr: any) {
      console.error("❌ Erreur lors de la sauvegarde en BDD:", {
        error: dbErr,
        code: dbErr?.code,
        message: dbErr?.message,
        stack: dbErr?.stack
      });
      
      if (dbErr.code === "SQLITE_CONSTRAINT_UNIQUE") {
        return res.status(409).json({ ok: false, error: "Cette date et heure sont déjà réservées" });
      }
      
      // Si l'email a été envoyé mais la BDD échoue, on retourne quand même une erreur
      // car la réservation n'a pas été enregistrée
      return res.status(500).json({ 
        ok: false, 
        error: "Erreur lors de l'enregistrement de la réservation. L'email a été envoyé mais la réservation n'a pas été sauvegardée." 
      });
    }

    // Cette ligne ne devrait jamais être atteinte car on retourne avant
    // Si on arrive ici, c'est qu'il y a eu un problème
    return res.status(500).json({ ok: false, error: "Erreur inattendue lors du traitement" });
  } catch (err) {
    console.error("❌ Erreur lors du traitement de la réservation:", {
      error: err,
      message: err instanceof Error ? err.message : "Erreur inconnue",
      stack: err instanceof Error ? err.stack : undefined,
      timestamp: new Date().toISOString()
    });
    return res.status(500).json({ 
      ok: false, 
      error: err instanceof Error ? err.message : "Erreur serveur lors du traitement de la réservation" 
    });
  }
});

// Articles directory - standalone, dans le répertoire backend
// Try multiple possible locations (standalone first)
const possibleDirs = [
  process.env.ARTICLES_DIR,
  path.join(process.cwd(), "articles"),  // backend/articles/ (standalone)
  path.join(__dirname, "articles"),      // backend/dist/articles/ (après build)
  // Fallback vers l'ancien emplacement pour compatibilité
  path.join(process.cwd(), "..", "articles"),
];

// Prioritize ARTICLES_DIR environment variable
let ARTICLES_DIR = process.env.ARTICLES_DIR;

// If not set, try to find it dans le répertoire backend (standalone)
if (!ARTICLES_DIR || !fs.existsSync(ARTICLES_DIR)) {
  ARTICLES_DIR = path.join(process.cwd(), "articles");
  
  // Find the first existing articles directory
  if (!fs.existsSync(ARTICLES_DIR)) {
    for (const dir of possibleDirs) {
      if (dir && fs.existsSync(dir)) {
        ARTICLES_DIR = dir;
        console.log(`📁 Found articles directory: ${ARTICLES_DIR}`);
        break;
      }
    }
  }
}

// Log articles directory on startup
console.log(`📁 Articles directory configured: ${ARTICLES_DIR}`);
console.log(`📁 Current working directory: ${process.cwd()}`);
console.log(`📁 Articles directory exists: ${fs.existsSync(ARTICLES_DIR)}`);
if (fs.existsSync(ARTICLES_DIR)) {
  const imgDir = path.join(ARTICLES_DIR, "img");
  console.log(`📁 Images directory: ${imgDir}`);
  console.log(`📁 Images directory exists: ${fs.existsSync(imgDir)}`);
  if (fs.existsSync(imgDir)) {
    const files = fs.readdirSync(imgDir);
    console.log(`📁 Available images: ${files.join(", ")}`);
  }
}

// Ensure articles directory exists
if (!fs.existsSync(ARTICLES_DIR)) {
  fs.mkdirSync(ARTICLES_DIR, { recursive: true });
  console.log(`📁 Created articles directory: ${ARTICLES_DIR}`);
}

// GET /api/articles - List all articles
app.get("/api/articles", (req, res) => {
  try {
    if (!fs.existsSync(ARTICLES_DIR)) {
      console.log(`Articles directory does not exist: ${ARTICLES_DIR}`);
      return res.json({ ok: true, articles: [] });
    }

    const files = fs.readdirSync(ARTICLES_DIR);
    const articles = files
      .filter((file) => file.endsWith(".json"))
      .map((file) => {
        try {
          const filePath = path.join(ARTICLES_DIR, file);
          let content = fs.readFileSync(filePath, "utf-8");
          
          // Remove BOM if present
          if (content.charCodeAt(0) === 0xFEFF) {
            content = content.slice(1);
          }
          
          // Trim whitespace
          content = content.trim();
          
          const article = JSON.parse(content);
          
          // Only include published articles (default to true if not specified)
          if (article.published === false) {
            return null;
          }

          // Build article data object, explicitly including all fields
          const articleData: any = {
            id: path.basename(file, ".json"),
            title: article.title,
            titleAr: article.titleAr,
            slug: article.slug,
            date: article.date,
            author: article.author,
            excerpt: article.excerpt,
            excerptAr: article.excerptAr,
            image: article.image,
            tags: article.tags,
            tagsAr: article.tagsAr,
            published: article.published !== false,
            // Don't include full content in list
          };
          
          // Explicitly add English fields if they exist in the parsed article
          if ('titleEn' in article) {
            articleData.titleEn = article.titleEn;
          }
          if ('excerptEn' in article) {
            articleData.excerptEn = article.excerptEn;
          }
          if ('tagsEn' in article) {
            articleData.tagsEn = article.tagsEn;
          }
          
          // Debug: log first article to verify English fields
          const firstFile = files.find(f => f.endsWith(".json"));
          if (firstFile && articleData.id === path.basename(firstFile, ".json")) {
            console.log(`📝 Article ${articleData.id} - English fields check:`, {
              hasTitleEnInArticle: 'titleEn' in article,
              hasExcerptEnInArticle: 'excerptEn' in article,
              hasTagsEnInArticle: 'tagsEn' in article,
              articleTitleEn: article.titleEn,
              articleExcerptEn: article.excerptEn,
              articleTagsEn: article.tagsEn,
              articleDataTitleEn: articleData.titleEn,
              articleDataExcerptEn: articleData.excerptEn,
              articleDataTagsEn: articleData.tagsEn
            });
          }
          
          return articleData;
        } catch (err) {
          console.error(`Error reading article ${file}:`, err);
          return null;
        }
      })
      .filter((article) => article !== null)
      .sort((a, b) => {
        // Sort by date (newest first)
        const dateA = new Date(a?.date || 0).getTime();
        const dateB = new Date(b?.date || 0).getTime();
        return dateB - dateA;
      });

    console.log(`Found ${articles.length} published articles`);
    return res.json({ ok: true, articles });
  } catch (err) {
    console.error("Error listing articles:", err);
    return res.status(500).json({ ok: false, error: "Failed to list articles" });
  }
});

// GET /api/articles/:slug - Get a specific article by slug
app.get("/api/articles/:slug", (req, res) => {
  try {
    const { slug } = req.params;
    
    // Try to find article by slug
    const files = fs.readdirSync(ARTICLES_DIR);
    let articleFile = null;
    
    for (const file of files) {
      if (file.endsWith(".json")) {
        try {
          const filePath = path.join(ARTICLES_DIR, file);
          const content = fs.readFileSync(filePath, "utf-8");
          const article = JSON.parse(content);
          if (article.slug === slug) {
            articleFile = file;
            break;
          }
        } catch (err) {
          // Skip invalid files
          continue;
        }
      }
    }

    if (!articleFile) {
      return res.status(404).json({ ok: false, error: "Article not found" });
    }

    const filePath = path.join(ARTICLES_DIR, articleFile);
    const content = fs.readFileSync(filePath, "utf-8");
    const article = JSON.parse(content);
    const id = path.basename(articleFile, ".json");

    // Debug: log article to verify English fields
    console.log(`📝 Single article ${id} - English fields:`, {
      hasTitleEn: !!article.titleEn,
      hasExcerptEn: !!article.excerptEn,
      hasContentEn: !!article.contentEn,
      hasTagsEn: !!article.tagsEn,
      titleEn: article.titleEn,
      excerptEn: article.excerptEn
    });

    return res.json({ ok: true, article: { id, ...article } });
  } catch (err) {
    console.error("Error reading article:", err);
    return res.status(500).json({ ok: false, error: "Failed to read article" });
  }
});

// GET /api/articles/images/:filename - Serve article images
app.get("/api/articles/images/:filename", (req, res) => {
  try {
    const { filename } = req.params;
    const imagePath = path.join(ARTICLES_DIR, "img", filename);
    
    console.log(`📸 Image request: ${filename}`);
    console.log(`📁 Articles directory: ${ARTICLES_DIR}`);
    console.log(`🖼️ Image path: ${imagePath}`);
    console.log(`✅ Path exists: ${fs.existsSync(imagePath)}`);
    
    // Security: prevent directory traversal
    const resolvedPath = path.resolve(imagePath);
    const articlesDir = path.resolve(ARTICLES_DIR);
    if (!resolvedPath.startsWith(articlesDir)) {
      console.error(`❌ Security check failed: ${resolvedPath} not in ${articlesDir}`);
      return res.status(403).json({ ok: false, error: "Access denied" });
    }
    
    if (!fs.existsSync(imagePath)) {
      console.error(`❌ Image not found: ${imagePath}`);
      // List available files for debugging
      const imgDir = path.join(ARTICLES_DIR, "img");
      console.log(`📂 Checking img directory: ${imgDir}`);
      console.log(`📂 img/ directory exists: ${fs.existsSync(imgDir)}`);
      if (fs.existsSync(imgDir)) {
        try {
          const files = fs.readdirSync(imgDir);
          console.log(`📂 Available files in img/: ${files.join(", ")}`);
          // Check permissions
          try {
            fs.accessSync(imgDir, fs.constants.R_OK);
            console.log(`✅ Read permission OK on img/ directory`);
          } catch (permErr) {
            console.error(`❌ Read permission denied on img/ directory:`, permErr);
          }
        } catch (readErr) {
          console.error(`❌ Cannot read img/ directory:`, readErr);
        }
      } else {
        console.error(`❌ img/ directory does not exist: ${imgDir}`);
        // List what's in ARTICLES_DIR
        try {
          const articlesFiles = fs.readdirSync(ARTICLES_DIR);
          console.log(`📂 Files in articles directory: ${articlesFiles.join(", ")}`);
        } catch (err) {
          console.error(`❌ Cannot read articles directory:`, err);
        }
      }
      return res.status(404).json({ ok: false, error: "Image not found", path: imagePath, articlesDir: ARTICLES_DIR });
    }
    
    // Determine content type based on file extension
    const ext = path.extname(filename).toLowerCase();
    const contentTypes: Record<string, string> = {
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".png": "image/png",
      ".gif": "image/gif",
      ".webp": "image/webp",
      ".svg": "image/svg+xml",
    };
    
    const contentType = contentTypes[ext] || "application/octet-stream";
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, max-age=31536000"); // Cache for 1 year
    
    const imageBuffer = fs.readFileSync(imagePath);
    console.log(`✅ Image served successfully: ${filename} (${imageBuffer.length} bytes)`);
    return res.send(imageBuffer);
  } catch (err) {
    console.error("❌ Error serving image:", err);
    return res.status(500).json({ ok: false, error: "Failed to serve image" });
  }
});

// ============================================
// ADMIN ENDPOINTS
// ============================================

// Middleware d'authentification
const authenticateToken = (req: express.Request, res: express.Response, next: express.NextFunction) => {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1]; // Bearer TOKEN

  if (!token) {
    return res.status(401).json({ ok: false, error: "Token manquant" });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as { username: string; role: string; userId: number };
    (req as any).user = decoded;
    next();
  } catch (err) {
    return res.status(403).json({ ok: false, error: "Token invalide" });
  }
};

// Middleware pour vérifier si l'utilisateur est admin
const requireAdmin = (req: express.Request, res: express.Response, next: express.NextFunction) => {
  const user = (req as any).user;
  
  if (!user) {
    return res.status(401).json({ ok: false, error: "Non authentifié" });
  }

  // Admin, Manager et SuperAdmin ont accès
  if (user.role !== 'admin' && user.role !== 'manager' && user.role !== 'superadmin') {
    return res.status(403).json({ ok: false, error: "Accès refusé. Droits administrateur requis." });
  }

  next();
};

// Middleware pour vérifier que l'utilisateur est SuperAdmin
const requireSuperAdmin = (req: express.Request, res: express.Response, next: express.NextFunction) => {
  const user = (req as any).user;
  
  if (!user) {
    return res.status(401).json({ ok: false, error: "Non authentifié" });
  }

  if (user.role !== 'superadmin') {
    return res.status(403).json({ ok: false, error: "Accès refusé. Seuls les super administrateurs peuvent effectuer cette action." });
  }

  next();
};

// POST /api/admin/login - Connexion admin
app.post("/api/admin/login", async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ ok: false, error: "Username et password requis" });
  }

  try {
    // Vérifier si un admin existe
    const admin = dbQueries.getAdminByUsername.get(username) as any;

    if (!admin) {
      return res.status(401).json({ ok: false, error: "Identifiants incorrects" });
    }

    // Vérifier si l'utilisateur est actif
    if (!admin.is_active) {
      return res.status(401).json({ ok: false, error: "Compte désactivé" });
    }

    // Vérifier le mot de passe
    const isValid = await bcrypt.compare(password, admin.password_hash);
    if (!isValid) {
      return res.status(401).json({ ok: false, error: "Identifiants incorrects" });
    }

    // Générer un token JWT avec le rôle
    const token = jwt.sign({ 
      username: admin.username, 
      userId: admin.id,
      role: admin.role || 'operator',
      fullName: admin.full_name
    }, JWT_SECRET, {
      expiresIn: "7d",
    });

    // Log d'audit
    createAuditLog({
      adminId: admin.id,
      adminUsername: admin.username,
      action: 'LOGIN',
      entityType: 'auth',
      description: `Connexion réussie`,
      ipAddress: req.ip || req.socket.remoteAddress
    });

    return res.json({ 
      ok: true, 
      token, 
      username: admin.username,
      role: admin.role || 'operator',
      fullName: admin.full_name
    });
  } catch (err) {
    console.error("Erreur lors de la connexion admin:", err);
    return res.status(500).json({ ok: false, error: "Erreur serveur" });
  }
});

// POST /api/admin/init - Initialiser le premier admin (à supprimer après la première utilisation)
app.post("/api/admin/init", async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ ok: false, error: "Username et password requis" });
  }

  try {
    // Vérifier si un admin existe déjà
    const existingAdmin = dbQueries.countAdmins.get() as any;

    if (existingAdmin && existingAdmin.count > 0) {
      return res.status(403).json({ ok: false, error: "Un admin existe déjà" });
    }

    // Hasher le mot de passe
    const passwordHash = await bcrypt.hash(password, 10);

    // Créer le super admin principal
    dbQueries.insertAdmin.run(username, passwordHash, username, 'superadmin', 1);

    console.log("✅ Premier super admin créé:", username);
    return res.json({ ok: true, message: "Super admin créé avec succès" });
  } catch (err) {
    console.error("Erreur lors de la création de l'admin:", err);
    return res.status(500).json({ ok: false, error: "Erreur serveur" });
  }
});

// ==================== GESTION DES UTILISATEURS ====================

// GET /api/admin/users - Liste tous les utilisateurs (admin uniquement)
app.get("/api/admin/users", authenticateToken, requireAdmin, (req, res) => {
  try {
    const users = dbQueries.getAllAdmins.all() as any[];
    return res.json({ ok: true, users });
  } catch (err) {
    console.error("Erreur lors de la récupération des utilisateurs:", err);
    return res.status(500).json({ ok: false, error: "Erreur serveur" });
  }
});

// GET /api/admin/users/:id - Récupérer un utilisateur par ID (admin uniquement)
app.get("/api/admin/users/:id", authenticateToken, requireAdmin, (req, res) => {
  try {
    const { id } = req.params;
    const user = dbQueries.getAdminById.get(id) as any;
    
    if (!user) {
      return res.status(404).json({ ok: false, error: "Utilisateur non trouvé" });
    }
    
    return res.json({ ok: true, user });
  } catch (err) {
    console.error("Erreur lors de la récupération de l'utilisateur:", err);
    return res.status(500).json({ ok: false, error: "Erreur serveur" });
  }
});

// POST /api/admin/users - Créer un nouvel utilisateur (superadmin uniquement)
app.post("/api/admin/users", authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const { username, password, fullName, role, isActive } = req.body;

    if (!username || !password) {
      return res.status(400).json({ ok: false, error: "Username et password requis" });
    }

    // Valider le rôle
    const validRoles = ['admin', 'manager', 'operator'];
    if (role && !validRoles.includes(role)) {
      return res.status(400).json({ ok: false, error: "Rôle invalide" });
    }

    // Vérifier si l'utilisateur existe déjà
    const existingUser = dbQueries.getAdminByUsername.get(username) as any;
    if (existingUser) {
      return res.status(400).json({ ok: false, error: "Cet utilisateur existe déjà" });
    }

    // Hasher le mot de passe
    const passwordHash = await bcrypt.hash(password, 10);

    // Créer l'utilisateur
    const result = dbQueries.insertAdmin.run(
      username,
      passwordHash,
      fullName || null,
      role || 'operator',
      isActive !== undefined ? (isActive ? 1 : 0) : 1
    );

    const userId = (result as any).lastInsertRowid;

    // Log d'audit
    createAuditLog({
      adminId: (req as any).user.userId,
      adminUsername: (req as any).user.username,
      action: 'CREATE',
      entityType: 'user',
      entityId: userId,
      newValue: { username, fullName, role: role || 'operator', isActive },
      description: `Création de l'utilisateur ${username}`,
      ipAddress: req.ip || req.socket.remoteAddress
    });

    return res.json({ 
      ok: true, 
      message: "Utilisateur créé avec succès",
      userId
    });
  } catch (err) {
    console.error("Erreur lors de la création de l'utilisateur:", err);
    return res.status(500).json({ ok: false, error: "Erreur serveur" });
  }
});

// PUT /api/admin/users/:id - Mettre à jour un utilisateur (admin uniquement)
app.put("/api/admin/users/:id", authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { username, fullName, role, isActive, password } = req.body;

    // Vérifier si l'utilisateur existe
    const existingUser = dbQueries.getAdminById.get(id) as any;
    if (!existingUser) {
      return res.status(404).json({ ok: false, error: "Utilisateur non trouvé" });
    }

    // Empêcher de modifier le dernier admin/superadmin
    const adminCount = dbQueries.countAdmins.get() as any;
    if ((existingUser.role === 'admin' || existingUser.role === 'superadmin') && adminCount.count === 1 && role !== 'admin' && role !== 'superadmin') {
      return res.status(400).json({ ok: false, error: "Impossible de modifier le rôle du dernier administrateur" });
    }

    // Valider le rôle
    const validRoles = ['admin', 'manager', 'operator'];
    if (role && !validRoles.includes(role)) {
      return res.status(400).json({ ok: false, error: "Rôle invalide" });
    }

    // Vérifier si le username est déjà pris par un autre utilisateur
    if (username && username !== existingUser.username) {
      const userWithSameUsername = dbQueries.getAdminByUsername.get(username) as any;
      if (userWithSameUsername) {
        return res.status(400).json({ ok: false, error: "Ce nom d'utilisateur est déjà pris" });
      }
    }

    // Mettre à jour l'utilisateur
    dbQueries.updateAdmin.run(
      username || existingUser.username,
      fullName !== undefined ? fullName : existingUser.full_name,
      role || existingUser.role,
      isActive !== undefined ? (isActive ? 1 : 0) : existingUser.is_active,
      id
    );

    // Mettre à jour le mot de passe si fourni
    if (password) {
      const passwordHash = await bcrypt.hash(password, 10);
      dbQueries.updateAdminPassword.run(passwordHash, id);
    }

    // Log d'audit
    createAuditLog({
      adminId: (req as any).user?.userId,
      adminUsername: (req as any).user?.username,
      action: 'UPDATE',
      entityType: 'user',
      entityId: id,
      oldValue: { username: existingUser.username, role: existingUser.role, isActive: existingUser.is_active },
      newValue: { username: username || existingUser.username, role: role || existingUser.role, isActive: isActive !== undefined ? isActive : existingUser.is_active },
      description: `Modification de l'utilisateur: ${username || existingUser.username}${password ? ' (mot de passe changé)' : ''}`,
      ipAddress: req.ip || req.socket.remoteAddress
    });

    return res.json({ ok: true, message: "Utilisateur mis à jour avec succès" });
  } catch (err) {
    console.error("Erreur lors de la mise à jour de l'utilisateur:", err);
    return res.status(500).json({ ok: false, error: "Erreur serveur" });
  }
});

// DELETE /api/admin/users/:id - Supprimer un utilisateur (admin uniquement)
app.delete("/api/admin/users/:id", authenticateToken, requireAdmin, (req, res) => {
  try {
    const { id } = req.params;
    const currentUserId = (req as any).user.userId;

    // Vérifier si l'utilisateur existe
    const existingUser = dbQueries.getAdminById.get(id) as any;
    if (!existingUser) {
      return res.status(404).json({ ok: false, error: "Utilisateur non trouvé" });
    }

    // Empêcher de supprimer soi-même
    if (parseInt(id) === currentUserId) {
      return res.status(400).json({ ok: false, error: "Impossible de supprimer votre propre compte" });
    }

    // Empêcher de supprimer le dernier admin/superadmin
    const adminCount = dbQueries.countAdmins.get() as any;
    if ((existingUser.role === 'admin' || existingUser.role === 'superadmin') && adminCount.count === 1) {
      return res.status(400).json({ ok: false, error: "Impossible de supprimer le dernier administrateur" });
    }

    // Supprimer l'utilisateur
    dbQueries.deleteAdmin.run(id);

    // Log d'audit
    createAuditLog({
      adminId: currentUserId,
      adminUsername: (req as any).user.username,
      action: 'DELETE',
      entityType: 'user',
      entityId: id,
      oldValue: { username: existingUser.username, role: existingUser.role },
      description: `Suppression de l'utilisateur ${existingUser.username}`,
      ipAddress: req.ip || req.socket.remoteAddress
    });

    return res.json({ ok: true, message: "Utilisateur supprimé avec succès" });
  } catch (err) {
    console.error("Erreur lors de la suppression de l'utilisateur:", err);
    return res.status(500).json({ ok: false, error: "Erreur serveur" });
  }
});

// ==================== GESTION DES MOTS DE PASSE ====================

// PUT /api/admin/profile/password - Changer son propre mot de passe
app.put("/api/admin/profile/password", authenticateToken, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const userId = (req as any).user.userId;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ ok: false, error: "Mot de passe actuel et nouveau mot de passe requis" });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ ok: false, error: "Le nouveau mot de passe doit contenir au moins 6 caractères" });
    }

    // Récupérer l'utilisateur avec le mot de passe
    const user = dbQueries.getAdminByUsername.get((req as any).user.username) as any;
    if (!user) {
      return res.status(404).json({ ok: false, error: "Utilisateur non trouvé" });
    }

    // Vérifier le mot de passe actuel
    const isValidPassword = await bcrypt.compare(currentPassword, user.password_hash);
    if (!isValidPassword) {
      return res.status(401).json({ ok: false, error: "Mot de passe actuel incorrect" });
    }

    // Hasher le nouveau mot de passe
    const hashedPassword = await bcrypt.hash(newPassword, 10);

    // Mettre à jour le mot de passe
    dbQueries.updateAdminPassword.run(hashedPassword, userId);

    return res.json({ ok: true, message: "Mot de passe modifié avec succès" });
  } catch (err) {
    console.error("Erreur lors du changement de mot de passe:", err);
    return res.status(500).json({ ok: false, error: "Erreur serveur" });
  }
});

// POST /api/admin/forgot-password - Demander un lien de réinitialisation
app.post("/api/admin/forgot-password", async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ ok: false, error: "Email requis" });
    }

    // Vérifier si l'utilisateur existe
    const user = dbQueries.getAdminByEmail.get(email) as any;
    
    // Toujours retourner un succès pour éviter l'énumération des emails
    if (!user) {
      console.log(`⚠️ Tentative de réinitialisation pour email inexistant: ${email}`);
      return res.json({ ok: true, message: "Si cet email existe, un lien de réinitialisation a été envoyé" });
    }

    // Générer un token unique
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 3600000); // 1 heure

    // Sauvegarder le token
    dbQueries.createPasswordResetToken.run(user.id, token, expiresAt.toISOString());

    // Créer le lien de réinitialisation
    const resetLink = `${process.env.FRONTEND_URL || 'http://localhost:5173'}/admin/reset-password?token=${token}`;

    // Configurer le transporteur email
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || "smtp.gmail.com",
      port: parseInt(process.env.SMTP_PORT || "587"),
      secure: false,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });

    // Envoyer l'email
    await transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: email,
      subject: "Réinitialisation de votre mot de passe - KBL CLEANNERS PRO",
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #333;">Réinitialisation de mot de passe</h2>
          <p>Bonjour ${user.full_name || user.username},</p>
          <p>Vous avez demandé la réinitialisation de votre mot de passe.</p>
          <p>Cliquez sur le lien ci-dessous pour créer un nouveau mot de passe :</p>
          <p style="margin: 30px 0;">
            <a href="${resetLink}" style="background-color: #4F46E5; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">
              Réinitialiser mon mot de passe
            </a>
          </p>
          <p style="color: #666; font-size: 14px;">
            Ce lien est valide pendant 1 heure.<br>
            Si vous n'avez pas demandé cette réinitialisation, ignorez cet email.
          </p>
          <p style="color: #999; font-size: 12px; margin-top: 40px;">
            KBL CLEANNERS PRO - Service de nettoyage professionnel
          </p>
        </div>
      `,
    });

    console.log(`✅ Email de réinitialisation envoyé à ${email}`);
    return res.json({ ok: true, message: "Si cet email existe, un lien de réinitialisation a été envoyé" });
  } catch (err) {
    console.error("Erreur lors de l'envoi de l'email de réinitialisation:", err);
    return res.status(500).json({ ok: false, error: "Erreur lors de l'envoi de l'email" });
  }
});

// POST /api/admin/reset-password - Réinitialiser le mot de passe avec le token
app.post("/api/admin/reset-password", async (req, res) => {
  try {
    const { token, newPassword } = req.body;

    if (!token || !newPassword) {
      return res.status(400).json({ ok: false, error: "Token et nouveau mot de passe requis" });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ ok: false, error: "Le mot de passe doit contenir au moins 6 caractères" });
    }

    // Nettoyer les tokens expirés
    dbQueries.deleteExpiredTokens.run();

    // Vérifier le token
    const resetToken = dbQueries.getPasswordResetToken.get(token) as any;
    if (!resetToken) {
      return res.status(400).json({ ok: false, error: "Token invalide ou expiré" });
    }

    // Hasher le nouveau mot de passe
    const hashedPassword = await bcrypt.hash(newPassword, 10);

    // Mettre à jour le mot de passe
    dbQueries.updateAdminPassword.run(hashedPassword, resetToken.admin_id);

    // Marquer le token comme utilisé
    dbQueries.markTokenAsUsed.run(token);

    console.log(`✅ Mot de passe réinitialisé pour l'utilisateur ID ${resetToken.admin_id}`);
    return res.json({ ok: true, message: "Mot de passe réinitialisé avec succès" });
  } catch (err) {
    console.error("Erreur lors de la réinitialisation du mot de passe:", err);
    return res.status(500).json({ ok: false, error: "Erreur serveur" });
  }
});

// GET /api/admin/verify-reset-token - Vérifier la validité d'un token
app.get("/api/admin/verify-reset-token", (req, res) => {
  try {
    const { token } = req.query;

    if (!token) {
      return res.status(400).json({ ok: false, error: "Token requis" });
    }

    // Nettoyer les tokens expirés
    dbQueries.deleteExpiredTokens.run();

    // Vérifier le token
    const resetToken = dbQueries.getPasswordResetToken.get(token) as any;
    
    if (!resetToken) {
      return res.json({ ok: false, valid: false, error: "Token invalide ou expiré" });
    }

    return res.json({ ok: true, valid: true });
  } catch (err) {
    console.error("Erreur lors de la vérification du token:", err);
    return res.status(500).json({ ok: false, error: "Erreur serveur" });
  }
});

// GET /api/admin/stats - Statistiques
app.get("/api/admin/stats", authenticateToken, (req, res) => {
  try {
    const stats = dbQueries.getStats.get() as any;
    return res.json({ ok: true, stats });
  } catch (err) {
    console.error("Erreur lors de la récupération des stats:", err);
    return res.status(500).json({ ok: false, error: "Erreur serveur" });
  }
});

// GET /api/admin/quotes - Liste des devis
app.get("/api/admin/quotes", authenticateToken, (req, res) => {
  try {
    const quotes = dbQueries.getQuotes.all() as any[];
    return res.json({ ok: true, quotes });
  } catch (err) {
    console.error("Erreur lors de la récupération des devis:", err);
    return res.status(500).json({ ok: false, error: "Erreur serveur" });
  }
});

// GET /api/admin/bookings - Liste des réservations (optionnel: filtrer par date)
app.get("/api/admin/bookings", authenticateToken, (req, res) => {
  try {
    const { date } = req.query;
    
    if (date) {
      // Retourner les réservations pour une date spécifique
      const bookings = dbQueries.getBookingsByDate.all(date) as any[];
      console.log(`📋 Réservations pour la date ${date}:`, bookings.length, bookings);
      return res.json({ ok: true, bookings });
    } else {
      // Retourner toutes les réservations
      const bookings = dbQueries.getBookings.all() as any[];
      console.log(`📋 Toutes les réservations récupérées:`, bookings.length);
      console.log(`📋 Détails des réservations:`, bookings.map((b: any) => ({
        id: b.id,
        name: b.name,
        status: b.status,
        payment_status: b.payment_status,
        preferred_date: b.preferred_date,
      })));
      return res.json({ ok: true, bookings });
    }
  } catch (err) {
    console.error("❌ Erreur lors de la récupération des réservations:", err);
    return res.status(500).json({ ok: false, error: "Erreur serveur" });
  }
});

// GET /api/admin/logs - Liste des logs d'audit
app.get("/api/admin/logs", authenticateToken, requireAdmin, (req, res) => {
  try {
    const { page = 1, limit = 50, action, adminId } = req.query;
    const offset = (Number(page) - 1) * Number(limit);

    let logs;
    let total;

    // Filtrer par action ET adminId
    if (action && adminId) {
      logs = dbQueries.getAuditLogsByActionAndAdmin.all(action, adminId, Number(limit), offset);
      const totalCount = dbQueries.countAuditLogsByActionAndAdmin.get(action, adminId) as any;
      total = totalCount.count;
    }
    // Filtrer par action uniquement
    else if (action) {
      logs = dbQueries.getAuditLogsByAction.all(action, Number(limit), offset);
      const totalCount = dbQueries.countAuditLogsByAction.get(action) as any;
      total = totalCount.count;
    }
    // Filtrer par adminId uniquement
    else if (adminId) {
      logs = dbQueries.getAuditLogsByAdmin.all(adminId, Number(limit), offset);
      const totalCount = dbQueries.countAuditLogsByAdmin.get(adminId) as any;
      total = totalCount.count;
    }
    // Aucun filtre
    else {
      logs = dbQueries.getAuditLogs.all(Number(limit), offset);
      const totalCount = dbQueries.countAuditLogs.get() as any;
      total = totalCount.count;
    }

    return res.json({ 
      ok: true, 
      logs,
      pagination: {
        page: Number(page),
        limit: Number(limit),
        total,
        totalPages: Math.ceil(total / Number(limit))
      }
    });
  } catch (err) {
    console.error("❌ Erreur lors de la récupération des logs:", err);
    return res.status(500).json({ ok: false, error: "Erreur serveur" });
  }
});

// DELETE /api/admin/logs - Purger tous les logs d'audit (Admin uniquement)
app.delete("/api/admin/logs", authenticateToken, requireAdmin, (req, res) => {
  try {
    const user = (req as any).user;
    
    // Compter le nombre de logs avant suppression
    const totalCount = dbQueries.countAuditLogs.get() as any;
    const logsDeleted = totalCount.count;
    
    // Supprimer tous les logs
    dbQueries.deleteAllAuditLogs.run();
    
    // Log d'audit pour la purge elle-même
    createAuditLog({
      adminId: user?.id,
      adminUsername: user?.username,
      action: 'DELETE',
      entityType: 'audit_logs',
      entityId: 'all',
      description: `Purge de ${logsDeleted} logs d'audit`,
      ipAddress: req.ip
    });
    
    console.log(`🗑️ ${logsDeleted} logs d'audit supprimés par ${user?.username}`);
    return res.json({ ok: true, logsDeleted });
  } catch (err) {
    console.error("❌ Erreur lors de la purge des logs:", err);
    return res.status(500).json({ ok: false, error: "Erreur serveur" });
  }
});

// GET /api/admin/payments - Liste de tous les paiements avec détails Stripe
app.get("/api/admin/payments", authenticateToken, async (req, res) => {
  try {
    // Récupérer toutes les réservations avec informations de paiement
    const payments = dbQueries.getBookings.all() as any[];
    
    // Enrichir les données avec les informations Stripe
    const paymentsData = await Promise.all(
      payments.map(async (booking: any) => {
        let amount = null;
        let transaction_timestamp = null;
        
        // Si on a un Payment Intent ID, récupérer les détails depuis Stripe
        if (booking.stripe_payment_intent_id && stripe) {
          try {
            const paymentIntent = await stripe.paymentIntents.retrieve(
              booking.stripe_payment_intent_id
            );
            
            // Montant en centimes, convertir en euros
            amount = paymentIntent.amount ? paymentIntent.amount / 100 : null;
            
            // Timestamp de la transaction (created timestamp de Stripe)
            transaction_timestamp = paymentIntent.created 
              ? new Date(paymentIntent.created * 1000).toISOString() 
              : null;
          } catch (stripeErr) {
            console.error(`❌ Erreur Stripe pour Payment Intent ${booking.stripe_payment_intent_id}:`, stripeErr);
          }
        }
        
        return {
          id: booking.id,
          name: booking.name,
          email: booking.email,
          phone: booking.phone,
          city: booking.city,
          service_type: booking.service_type,
          service_name: booking.service_name,
          preferred_date: booking.preferred_date,
          preferred_time: booking.preferred_time,
          payment_status: booking.payment_status || 'unpaid',
          stripe_payment_intent_id: booking.stripe_payment_intent_id,
          amount,
          transaction_timestamp,
          created_at: booking.created_at,
          status: booking.status,
        };
      })
    );

    return res.json({ ok: true, payments: paymentsData });
  } catch (err) {
    console.error("❌ Erreur lors de la récupération des paiements:", err);
    return res.status(500).json({ ok: false, error: "Erreur serveur" });
  }
});

// PUT /api/admin/quotes/:id/status - Mettre à jour le statut d'un devis
app.put("/api/admin/quotes/:id/status", authenticateToken, (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    const validStatuses = ["pending", "contacted", "converted", "cancelled"];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ ok: false, error: "Statut invalide" });
    }

    // Récupérer l'ancienne valeur
    const oldQuote = dbQueries.getQuoteById.get(id) as any;
    const oldStatus = oldQuote?.status;

    dbQueries.updateQuoteStatus.run(status, id);
    const quote = dbQueries.getQuoteById.get(id);

    // Log d'audit
    createAuditLog({
      adminId: (req as any).user?.userId,
      adminUsername: (req as any).user?.username,
      action: 'STATUS_CHANGE',
      entityType: 'quote',
      entityId: id,
      oldValue: { status: oldStatus },
      newValue: { status },
      description: `Changement de statut de devis: ${oldStatus} → ${status} (${oldQuote?.name})`,
      ipAddress: req.ip || req.socket.remoteAddress
    });

    return res.json({ ok: true, quote });
  } catch (err) {
    console.error("Erreur lors de la mise à jour du devis:", err);
    return res.status(500).json({ ok: false, error: "Erreur serveur" });
  }
});

// PUT /api/admin/bookings/:id/status - Mettre à jour le statut d'une réservation
app.put("/api/admin/bookings/:id/status", authenticateToken, (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    const validStatuses = ["pending", "confirmed", "completed", "cancelled", "awaiting_payment"];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ ok: false, error: "Statut invalide" });
    }

    // Récupérer l'ancienne valeur avant modification
    const oldBooking = dbQueries.getBookingById.get(id) as any;
    const oldStatus = oldBooking?.status;

    dbQueries.updateBookingStatus.run(status, id);
    const booking = dbQueries.getBookingById.get(id);

    // Log d'audit
    createAuditLog({
      adminId: (req as any).user?.userId,
      adminUsername: (req as any).user?.username,
      action: 'STATUS_CHANGE',
      entityType: 'booking',
      entityId: id,
      oldValue: { status: oldStatus },
      newValue: { status },
      description: `Changement de statut de réservation: ${oldStatus} → ${status}`,
      ipAddress: req.ip || req.socket.remoteAddress
    });

    return res.json({ ok: true, booking });
  } catch (err) {
    console.error("Erreur lors de la mise à jour de la réservation:", err);
    return res.status(500).json({ ok: false, error: "Erreur serveur" });
  }
});

// GET /api/admin/config - Récupérer la configuration
app.get("/api/admin/config", authenticateToken, (req, res) => {
  try {
    const quotesConfig = dbQueries.getConfig.get("quotes_enabled") as any;
    const quotesEnabled = quotesConfig?.value === "true";
    const timeSelectionConfig = dbQueries.getConfig.get("time_selection_enabled") as any;
    const timeSelectionEnabled = timeSelectionConfig?.value !== "false"; // Par défaut true
    const languagesConfig = dbQueries.getConfig.get("languages_enabled") as any;
    const languagesEnabled = languagesConfig?.value !== "false"; // Par défaut true
    const testModeConfig = dbQueries.getConfig.get("test_mode_enabled") as any;
    const testModeEnabled = testModeConfig?.value === "true";
    const maxBookingsConfig = dbQueries.getConfig.get("max_bookings_per_day") as any;
    const maxBookingsPerDay = parseInt(maxBookingsConfig?.value || "5", 10);
    const contactPhoneConfig = dbQueries.getConfig.get("contact_phone") as any;
    const contactPhone = contactPhoneConfig?.value || "";
    const cities = dbQueries.getAllServiceCities.all() as any[];
    
    console.log("📍 Villes brutes de la DB:", cities);
    const mappedCities = cities.map(c => ({
      id: c.id,
      cityName: c.city_name,
      postalCode: c.postal_code,
      passage1Week: c.passage1_week,
      passage1Day: c.passage1_day,
      passage2Week: c.passage2_week,
      passage2Day: c.passage2_day,
      enabled: c.enabled === 1,
      cutoffDate: c.cutoff_date,
    }));
    console.log("📍 Villes mappées pour l'API:", mappedCities);
    
    return res.json({
      ok: true,
      config: {
        quotesEnabled,
        timeSelectionEnabled,
        languagesEnabled,
        testModeEnabled,
        maxBookingsPerDay,
        contactPhone,
        cities: mappedCities,
      },
    });
  } catch (err) {
    console.error("Erreur lors de la récupération de la config:", err);
    return res.status(500).json({ ok: false, error: "Erreur serveur" });
  }
});

// PUT /api/admin/config/quotes - Activer/désactiver les devis (admin uniquement)
app.put("/api/admin/config/quotes", authenticateToken, requireAdmin, (req, res) => {
  try {
    const { enabled } = req.body;
    
    if (typeof enabled !== "boolean") {
      return res.status(400).json({ ok: false, error: "Le paramètre 'enabled' doit être un booléen" });
    }

    const oldValueConfig = dbQueries.getConfig.get("quotes_enabled") as any;
    const oldValue = oldValueConfig?.value;
    dbQueries.setConfig.run("quotes_enabled", enabled ? "true" : "false");

    // Log d'audit
    createAuditLog({
      adminId: (req as any).user?.userId,
      adminUsername: (req as any).user?.username,
      action: 'CONFIG_CHANGE',
      entityType: 'config',
      entityId: 'quotes_enabled',
      oldValue: { quotes_enabled: oldValue },
      newValue: { quotes_enabled: enabled ? "true" : "false" },
      description: `Modification config: Devis ${enabled ? 'activés' : 'désactivés'}`,
      ipAddress: req.ip || req.socket.remoteAddress
    });
    
    return res.json({ ok: true, quotesEnabled: enabled });
  } catch (err) {
    console.error("Erreur lors de la mise à jour de la config:", err);
    return res.status(500).json({ ok: false, error: "Erreur serveur" });
  }
});

// PUT /api/admin/config/time-selection - Activer/désactiver la sélection d'heure (admin uniquement)
app.put("/api/admin/config/time-selection", authenticateToken, requireAdmin, (req, res) => {
  try {
    const { enabled } = req.body;
    const user = (req as any).user;
    
    if (typeof enabled !== "boolean") {
      return res.status(400).json({ ok: false, error: "Le paramètre 'enabled' doit être un booléen" });
    }

    dbQueries.setConfig.run("time_selection_enabled", enabled ? "true" : "false");
    
    // Log d'audit
    createAuditLog({
      adminId: user?.id,
      adminUsername: user?.username,
      action: 'CONFIG_CHANGE',
      entityType: 'config',
      entityId: 'time_selection_enabled',
      newValue: { enabled },
      description: `Sélection d'heure ${enabled ? 'activée' : 'désactivée'}`,
      ipAddress: req.ip
    });
    
    return res.json({ ok: true, timeSelectionEnabled: enabled });
  } catch (err) {
    console.error("Erreur lors de la mise à jour de la config:", err);
    return res.status(500).json({ ok: false, error: "Erreur serveur" });
  }
});

// PUT /api/admin/config/languages - Activer/désactiver les langues (admin uniquement)
app.put("/api/admin/config/languages", authenticateToken, requireAdmin, (req, res) => {
  try {
    const { enabled } = req.body;
    const user = (req as any).user;
    
    if (typeof enabled !== "boolean") {
      return res.status(400).json({ ok: false, error: "Le paramètre 'enabled' doit être un booléen" });
    }

    dbQueries.setConfig.run("languages_enabled", enabled ? "true" : "false");
    
    // Log d'audit
    createAuditLog({
      adminId: user?.id,
      adminUsername: user?.username,
      action: 'CONFIG_CHANGE',
      entityType: 'config',
      entityId: 'languages_enabled',
      newValue: { enabled },
      description: `Langues ${enabled ? 'activées' : 'désactivées'}`,
      ipAddress: req.ip
    });
    
    return res.json({ ok: true, languagesEnabled: enabled });
  } catch (err) {
    console.error("Erreur lors de la mise à jour de la config:", err);
    return res.status(500).json({ ok: false, error: "Erreur serveur" });
  }
});

// PUT /api/admin/config/test-mode - Activer/désactiver le mode test
app.put("/api/admin/config/test-mode", authenticateToken, (req, res) => {
  try {
    const { enabled } = req.body;
    const user = (req as any).user;
    
    if (typeof enabled !== "boolean") {
      return res.status(400).json({ ok: false, error: "Le paramètre 'enabled' doit être un booléen" });
    }

    dbQueries.setConfig.run("test_mode_enabled", enabled ? "true" : "false");
    
    // Log d'audit
    createAuditLog({
      adminId: user?.id,
      adminUsername: user?.username,
      action: 'CONFIG_CHANGE',
      entityType: 'config',
      entityId: 'test_mode_enabled',
      newValue: { enabled },
      description: `Mode test Stripe ${enabled ? 'activé' : 'désactivé'}`,
      ipAddress: req.ip
    });
    
    console.log(`✅ Mode test ${enabled ? "activé" : "désactivé"}`);
    return res.json({ ok: true, testModeEnabled: enabled });
  } catch (err) {
    console.error("Erreur lors de la mise à jour de la config:", err);
    return res.status(500).json({ ok: false, error: "Erreur serveur" });
  }
});

// PUT /api/admin/config/max-bookings - Définir la limite de réservations par jour
app.put("/api/admin/config/max-bookings", authenticateToken, (req, res) => {
  try {
    console.log("📝 Requête reçue pour mettre à jour max_bookings_per_day:", req.body);
    const { maxBookingsPerDay } = req.body;
    const user = (req as any).user;
    
    if (maxBookingsPerDay === undefined || maxBookingsPerDay === null) {
      console.error("❌ maxBookingsPerDay est undefined ou null");
      return res.status(400).json({ ok: false, error: "Le paramètre 'maxBookingsPerDay' est requis" });
    }
    
    const numValue = typeof maxBookingsPerDay === "string" ? parseInt(maxBookingsPerDay, 10) : maxBookingsPerDay;
    
    if (isNaN(numValue) || numValue < 1) {
      console.error("❌ maxBookingsPerDay n'est pas un nombre valide:", maxBookingsPerDay);
      return res.status(400).json({ ok: false, error: "Le paramètre 'maxBookingsPerDay' doit être un nombre positif" });
    }

    console.log("💾 Mise à jour de max_bookings_per_day à:", numValue);
    dbQueries.setConfig.run("max_bookings_per_day", numValue.toString());
    
    // Log d'audit
    createAuditLog({
      adminId: user?.id,
      adminUsername: user?.username,
      action: 'CONFIG_CHANGE',
      entityType: 'config',
      entityId: 'max_bookings_per_day',
      newValue: { maxBookingsPerDay: numValue },
      description: `Limite de réservations par jour définie à ${numValue}`,
      ipAddress: req.ip
    });
    
    console.log("✅ Configuration mise à jour avec succès");
    return res.json({ ok: true, maxBookingsPerDay: numValue });
  } catch (err) {
    console.error("❌ Erreur lors de la mise à jour de la config:", err);
    return res.status(500).json({ ok: false, error: "Erreur serveur" });
  }
});

// PUT /api/admin/config/contact-phone - Mettre à jour le téléphone de contact
app.put("/api/admin/config/contact-phone", authenticateToken, (req, res) => {
  try {
    const { contactPhone } = req.body;
    const user = (req as any).user;
    
    if (contactPhone === undefined) {
      return res.status(400).json({ ok: false, error: "Le paramètre 'contactPhone' est requis" });
    }

    dbQueries.setConfig.run("contact_phone", contactPhone);
    
    // Log d'audit
    createAuditLog({
      adminId: user?.id,
      adminUsername: user?.username,
      action: 'CONFIG_CHANGE',
      entityType: 'config',
      entityId: 'contact_phone',
      newValue: { contactPhone },
      description: `Téléphone de contact mis à jour : ${contactPhone}`,
      ipAddress: req.ip
    });
    
    return res.json({ ok: true, contactPhone });
  } catch (err) {
    console.error("Erreur lors de la mise à jour du téléphone:", err);
    return res.status(500).json({ ok: false, error: "Erreur serveur" });
  }
});

// GET /api/admin/bookings/calendar - Récupérer les réservations pour le calendrier
app.get("/api/admin/bookings/calendar", authenticateToken, (req, res) => {
  try {
    const { startDate, endDate, serviceType } = req.query;
    
    if (!startDate || !endDate) {
      return res.status(400).json({ ok: false, error: "startDate et endDate sont requis" });
    }

    // Récupérer les réservations en fonction du filtre de service
    let allBookingsInPeriod: any[];
    let paidBookingsInPeriod: any[];

    if (serviceType && serviceType !== 'all') {
      // Filtrer par service spécifique
      allBookingsInPeriod = dbQueries.getBookingsByDateRangeAndService.all(startDate, endDate, serviceType) as any[];
      paidBookingsInPeriod = dbQueries.getPaidBookingsByDateRangeAndService.all(startDate, endDate, serviceType) as any[];
    } else {
      // Récupérer toutes les réservations (non annulées) pour l'affichage
      allBookingsInPeriod = dbQueries.getBookingsByDateRange.all(startDate, endDate) as any[];
      
      // Récupérer les réservations payées pour vérifier la limite
      paidBookingsInPeriod = dbQueries.getPaidBookingsByDateRange.all(startDate, endDate) as any[];
    }
    
    // Créer un map des dates avec leurs comptes
    const paidCountsByDate = new Map<string, number>();
    paidBookingsInPeriod.forEach(b => {
      let count = 0;
      if (typeof b.count === 'number') {
        count = b.count;
      } else if (typeof b.count === 'bigint') {
        count = Number(b.count);
      } else if (typeof b.count === 'string') {
        count = parseInt(b.count, 10) || 0;
      }
      paidCountsByDate.set(b.preferred_date, count);
    });
    
    // Formater les résultats : afficher le total des réservations, mais utiliser les payées pour la limite
    const formattedBookings = allBookingsInPeriod.map(b => {
      let totalCount = 0;
      if (typeof b.count === 'number') {
        totalCount = b.count;
      } else if (typeof b.count === 'bigint') {
        totalCount = Number(b.count);
      } else if (typeof b.count === 'string') {
        totalCount = parseInt(b.count, 10) || 0;
      }
      
      // Le nombre de réservations payées pour cette date
      const paidCount = paidCountsByDate.get(b.preferred_date) || 0;
      
      return {
        date: b.preferred_date,
        count: totalCount, // Total des réservations (non annulées)
        paidCount: paidCount, // Nombre de réservations payées (pour la limite)
      };
    });
    
    // Ajouter les dates qui ont seulement des réservations payées mais pas de total
    paidCountsByDate.forEach((paidCount, date) => {
      if (!formattedBookings.find(b => b.date === date)) {
        formattedBookings.push({
          date: date,
          count: 0,
          paidCount: paidCount,
        });
      }
    });
    
    console.log(`📅 Calendrier ${startDate} à ${endDate}:`, {
      totalReservations: allBookingsInPeriod.length,
      paidReservations: paidBookingsInPeriod.length,
      formatted: formattedBookings,
    });
    
    return res.json({
      ok: true,
      bookings: formattedBookings,
    });
  } catch (err) {
    console.error("Erreur lors de la récupération du calendrier:", err);
    return res.status(500).json({ ok: false, error: "Erreur serveur" });
  }
});

// POST /api/admin/cities - Ajouter une ville
app.post("/api/admin/cities", authenticateToken, (req, res) => {
  try {
    const { cityName, postalCode, passage1Week, passage1Day, passage2Week, passage2Day, enabled = true, cutoffDate } = req.body;
    
    if (!cityName) {
      return res.status(400).json({ ok: false, error: "Le nom de la ville est requis" });
    }

    const result = dbQueries.addServiceCity.run(
      cityName, 
      postalCode || null, 
      passage1Week || null, 
      passage1Day || null,
      passage2Week || null,
      passage2Day || null,
      enabled ? 1 : 0,
      cutoffDate || null
    );

    // Log d'audit
    createAuditLog({
      adminId: (req as any).user?.userId,
      adminUsername: (req as any).user?.username,
      action: 'CREATE',
      entityType: 'city',
      entityId: Number(result.lastInsertRowid),
      newValue: { cityName, postalCode, enabled, cutoffDate },
      description: `Ajout de la ville: ${cityName}`,
      ipAddress: req.ip || req.socket.remoteAddress
    });
    
    return res.json({ ok: true });
  } catch (err: any) {
    if (err.code === "SQLITE_CONSTRAINT_UNIQUE") {
      return res.status(409).json({ ok: false, error: "Cette ville existe déjà" });
    }
    console.error("Erreur lors de l'ajout de la ville:", err);
    return res.status(500).json({ ok: false, error: "Erreur serveur" });
  }
});

// PUT /api/admin/cities/:id - Modifier une ville
app.put("/api/admin/cities/:id", authenticateToken, (req, res) => {
  try {
    const { id } = req.params;
    const { cityName, postalCode, passage1Week, passage1Day, passage2Week, passage2Day, enabled, cutoffDate } = req.body;
    
    if (!cityName) {
      return res.status(400).json({ ok: false, error: "Le nom de la ville est requis" });
    }

    dbQueries.updateServiceCity.run(
      cityName,
      postalCode || null,
      passage1Week || null,
      passage1Day || null,
      passage2Week || null,
      passage2Day || null,
      enabled ? 1 : 0,
      cutoffDate || null,
      id
    );

    // Log d'audit
    createAuditLog({
      adminId: (req as any).user?.userId,
      adminUsername: (req as any).user?.username,
      action: 'UPDATE',
      entityType: 'city',
      entityId: id,
      newValue: { cityName, postalCode, enabled, cutoffDate },
      description: `Modification de la ville: ${cityName}`,
      ipAddress: req.ip || req.socket.remoteAddress
    });
    
    return res.json({ ok: true });
  } catch (err) {
    console.error("Erreur lors de la modification de la ville:", err);
    return res.status(500).json({ ok: false, error: "Erreur serveur" });
  }
});

// DELETE /api/admin/cities/:id - Supprimer une ville
app.delete("/api/admin/cities/:id", authenticateToken, (req, res) => {
  try {
    const { id } = req.params;

    // Récupérer les infos avant suppression
    const city = db.prepare("SELECT * FROM service_cities WHERE id = ?").get(id) as any;
    
    dbQueries.deleteServiceCity.run(id);

    // Log d'audit
    if (city) {
      createAuditLog({
        adminId: (req as any).user?.userId,
        adminUsername: (req as any).user?.username,
        action: 'DELETE',
        entityType: 'city',
        entityId: id,
        oldValue: { cityName: city.city_name, postalCode: city.postal_code },
        description: `Suppression de la ville: ${city.city_name}`,
        ipAddress: req.ip || req.socket.remoteAddress
      });
    }
    
    return res.json({ ok: true });
  } catch (err) {
    console.error("Erreur lors de la suppression de la ville:", err);
    return res.status(500).json({ ok: false, error: "Erreur serveur" });
  }
});

// GET /api/services - Récupérer les services activés (publique)
app.get("/api/services", (req, res) => {
  try {
    const services = dbQueries.getEnabledServices.all() as any[];
    
    return res.json({
      ok: true,
      services: services.map(s => ({
        id: s.service_id,
        name: s.name,
        translationKey: s.translation_key,
        stripeProductId: s.stripe_product_id,
        price: s.price || 0,
        enabled: s.enabled === 1,
        order: s.display_order,
        isSubscription: s.is_subscription === 1,
        information: s.information,
        contractUrl: s.contract_url,
      })),
    });
  } catch (err) {
    console.error("Erreur lors de la récupération des services:", err);
    return res.status(500).json({ ok: false, error: "Erreur serveur" });
  }
});

// GET /api/admin/services - Récupérer tous les services (admin)
app.get("/api/admin/services", authenticateToken, (req, res) => {
  try {
    const services = dbQueries.getAllServices.all() as any[];
    
    return res.json({
      ok: true,
      services: services.map(s => ({
        id: s.id,
        serviceId: s.service_id,
        name: s.name,
        translationKey: s.translation_key,
        stripeProductId: s.stripe_product_id,
        price: s.price || 0,
        enabled: s.enabled === 1,
        order: s.display_order,
        passage1Week: s.passage1_week,
        passage1Day: s.passage1_day,
        passage2Week: s.passage2_week,
        passage2Day: s.passage2_day,
        maxBookingsPerDay: s.max_bookings_per_day,
        isSubscription: s.is_subscription === 1,
        information: s.information,
        contractUrl: s.contract_url,
      })),
    });
  } catch (err) {
    console.error("Erreur lors de la récupération des services:", err);
    return res.status(500).json({ ok: false, error: "Erreur serveur" });
  }
});

// POST /api/admin/services - Ajouter un service
app.post("/api/admin/services", authenticateToken, (req, res) => {
  try {
    const { 
      serviceId, name, translationKey, stripeProductId, price = 0, enabled = true, order = 0,
      passage1Week = null, passage1Day = null, passage2Week = null, passage2Day = null, maxBookingsPerDay = null,
      isSubscription = false, information = null, contractUrl = null
    } = req.body;
    
    if (!serviceId || !name) {
      return res.status(400).json({ ok: false, error: "serviceId et name sont requis" });
    }

    // Vérifier si le service_id existe déjà
    const existing = dbQueries.getServiceByServiceId.get(serviceId);
    if (existing) {
      return res.status(409).json({ ok: false, error: "Un service avec cet ID existe déjà" });
    }

    const result = dbQueries.insertService.run(
      serviceId, name, translationKey || null, stripeProductId || null, price || 0, 
      enabled ? 1 : 0, order, 
      passage1Week, passage1Day, passage2Week, passage2Day, maxBookingsPerDay,
      isSubscription ? 1 : 0, information || null, contractUrl || null
    );

    const newServiceId = result.lastInsertRowid;

    // Log d'audit
    createAuditLog({
      adminId: (req as any).user?.userId,
      adminUsername: (req as any).user?.username,
      action: 'CREATE',
      entityType: 'service',
      entityId: Number(newServiceId),
      newValue: { serviceId, name, price, enabled },
      description: `Création du service: ${name}`,
      ipAddress: req.ip || req.socket.remoteAddress
    });
    
    return res.json({ 
      ok: true, 
      service: {
        id: newServiceId,
        serviceId,
        name,
        translationKey: translationKey || null,
        stripeProductId: stripeProductId || null,
        price: price || 0,
        enabled,
        order,
        passage1Week,
        passage1Day,
        passage2Week,
        passage2Day,
      }
    });
  } catch (err: any) {
    console.error("Erreur lors de l'ajout du service:", err);
    if (err.code === "SQLITE_CONSTRAINT_UNIQUE") {
      return res.status(409).json({ ok: false, error: "Un service avec cet ID existe déjà" });
    }
    return res.status(500).json({ ok: false, error: "Erreur serveur" });
  }
});

// PUT /api/admin/services/:id - Modifier un service
app.put("/api/admin/services/:id", authenticateToken, (req, res) => {
  try {
    const { id } = req.params;
    const { 
      serviceId, name, translationKey, stripeProductId, price, enabled, order,
      passage1Week = null, passage1Day = null, passage2Week = null, passage2Day = null, maxBookingsPerDay = null,
      isSubscription = false, information = null, contractUrl = null
    } = req.body;
    
    if (!serviceId || !name) {
      return res.status(400).json({ ok: false, error: "serviceId et name sont requis" });
    }

    // Vérifier si le service existe
    const existing = dbQueries.getServiceById.get(id) as any;
    if (!existing) {
      return res.status(404).json({ ok: false, error: "Service non trouvé" });
    }

    // Vérifier si le service_id est déjà utilisé par un autre service
    const conflict = dbQueries.getServiceByServiceId.get(serviceId);
    const conflictTyped = conflict as any;
    if (conflictTyped && conflictTyped.id !== parseInt(id, 10)) {
      return res.status(409).json({ ok: false, error: "Un service avec cet ID existe déjà" });
    }

    dbQueries.updateService.run(
      serviceId, name, translationKey || null, stripeProductId || null, price || 0, 
      enabled ? 1 : 0, order || 0, 
      passage1Week, passage1Day, passage2Week, passage2Day, maxBookingsPerDay,
      isSubscription ? 1 : 0, information || null, contractUrl || null,
      id
    );

    // Log d'audit
    createAuditLog({
      adminId: (req as any).user?.userId,
      adminUsername: (req as any).user?.username,
      action: 'UPDATE',
      entityType: 'service',
      entityId: id,
      oldValue: { name: existing.name, price: existing.price, enabled: existing.enabled },
      newValue: { name, price, enabled },
      description: `Modification du service: ${name}`,
      ipAddress: req.ip || req.socket.remoteAddress
    });
    
    return res.json({ ok: true });
  } catch (err: any) {
    console.error("Erreur lors de la modification du service:", err);
    if (err.code === "SQLITE_CONSTRAINT_UNIQUE") {
      return res.status(409).json({ ok: false, error: "Un service avec cet ID existe déjà" });
    }
    return res.status(500).json({ ok: false, error: "Erreur serveur" });
  }
});

// DELETE /api/admin/services/:id - Supprimer un service
app.delete("/api/admin/services/:id", authenticateToken, (req, res) => {
  try {
    const { id } = req.params;
    
    // Vérifier si le service existe
    const existing = dbQueries.getServiceById.get(id) as any;
    if (!existing) {
      return res.status(404).json({ ok: false, error: "Service non trouvé" });
    }

    dbQueries.deleteService.run(id);

    // Log d'audit
    createAuditLog({
      adminId: (req as any).user?.userId,
      adminUsername: (req as any).user?.username,
      action: 'DELETE',
      entityType: 'service',
      entityId: id,
      oldValue: { name: existing.name, serviceId: existing.service_id },
      description: `Suppression du service: ${existing.name}`,
      ipAddress: req.ip || req.socket.remoteAddress
    });
    
    return res.json({ ok: true });
  } catch (err) {
    console.error("Erreur lors de la suppression du service:", err);
    return res.status(500).json({ ok: false, error: "Erreur serveur" });
  }
});

// POST /api/admin/services/sync-stripe-prices - Synchroniser les prix depuis Stripe
app.post("/api/admin/services/sync-stripe-prices", authenticateToken, async (req, res) => {
  try {
    if (!stripe) {
      return res.status(503).json({ ok: false, error: "Stripe non configuré" });
    }

    const services = dbQueries.getAllServices.all() as any[];
    let syncCount = 0;
    const errors: string[] = [];

    for (const service of services) {
      if (!service.stripe_product_id) {
        continue; // Skip services without Stripe product ID
      }

      try {
        // Récupérer le produit Stripe
        const product = await stripe.products.retrieve(service.stripe_product_id);
        
        // Récupérer les prix associés au produit
        const prices = await stripe.prices.list({
          product: service.stripe_product_id,
          active: true,
          limit: 1, // On prend le premier prix actif
        });

        if (prices.data.length > 0) {
          const price = prices.data[0];
          // Mettre à jour le prix dans la base de données (en centimes)
          dbQueries.updateService.run(
            service.service_id,
            service.name,
            service.translation_key,
            service.stripe_product_id,
            price.unit_amount || 0, // Prix en centimes
            service.enabled,
            service.display_order,
            service.passage1_week,
            service.passage1_day,
            service.passage2_week,
            service.passage2_day,
            service.max_bookings_per_day,
            service.is_subscription || 0,
            service.information,
            service.contract_url || null, // Ajout du contract_url
            service.id
          );
          syncCount++;
          console.log(`✅ Prix synchronisé pour ${service.name}: ${price.unit_amount} centimes`);
        } else {
          errors.push(`Aucun prix actif trouvé pour ${service.name}`);
        }
      } catch (err: any) {
        console.error(`❌ Erreur lors de la sync du service ${service.name}:`, err.message);
        errors.push(`Erreur pour ${service.name}: ${err.message}`);
      }
    }

    return res.json({ 
      ok: true, 
      syncCount,
      errors: errors.length > 0 ? errors : undefined,
      message: `${syncCount} prix synchronisé(s) depuis Stripe${errors.length > 0 ? ` (${errors.length} erreur(s))` : ''}`
    });
  } catch (err: any) {
    console.error("Erreur lors de la synchronisation des prix Stripe:", err);
    return res.status(500).json({ ok: false, error: err.message || "Erreur serveur" });
  }
});

// ================== ROUTES API POUR LES VARIANTES DE SERVICES ==================

// GET /api/services/:serviceId/variants - Récupérer les variantes activées d'un service (publique)
app.get("/api/services/:serviceId/variants", (req, res) => {
  try {
    const { serviceId } = req.params;
    
    // Récupérer le service
    const service = dbQueries.getServiceByServiceId.get(serviceId) as any;
    if (!service) {
      return res.status(404).json({ ok: false, error: "Service non trouvé" });
    }

    const variants = dbQueries.getEnabledVariantsByServiceId.all(service.id) as any[];
    
    return res.json({
      ok: true,
      variants: variants.map(v => ({
        id: v.id,
        serviceId: service.id,
        name: v.name,
        description: v.description,
        priceModifier: v.price_modifier || 0,
        imagePath: v.image_path,
        enabled: v.enabled === 1,
        order: v.display_order,
      })),
    });
  } catch (err) {
    console.error("Erreur lors de la récupération des variantes:", err);
    return res.status(500).json({ ok: false, error: "Erreur serveur" });
  }
});

// GET /api/admin/services/:serviceId/variants - Récupérer toutes les variantes d'un service (admin)
app.get("/api/admin/services/:serviceId/variants", authenticateToken, (req, res) => {
  try {
    const { serviceId } = req.params;
    
    const service = dbQueries.getServiceById.get(serviceId) as any;
    if (!service) {
      return res.status(404).json({ ok: false, error: "Service non trouvé" });
    }

    const variants = dbQueries.getVariantsByServiceId.all(serviceId) as any[];
    
    return res.json({
      ok: true,
      variants: variants.map(v => ({
        id: v.id,
        serviceId: service.id,
        name: v.name,
        description: v.description,
        priceModifier: v.price_modifier || 0,
        imagePath: v.image_path,
        enabled: v.enabled === 1,
        order: v.display_order,
        createdAt: v.created_at,
        updatedAt: v.updated_at,
      })),
    });
  } catch (err) {
    console.error("Erreur lors de la récupération des variantes:", err);
    return res.status(500).json({ ok: false, error: "Erreur serveur" });
  }
});

// POST /api/admin/services/:serviceId/variants - Ajouter une variante à un service
app.post("/api/admin/services/:serviceId/variants", authenticateToken, upload.single('image'), (req, res) => {
  try {
    const { serviceId } = req.params;
    const { name, description, priceModifier = 0, enabled = true, order = 0 } = req.body;
    
    if (!name) {
      return res.status(400).json({ ok: false, error: "Le nom est requis" });
    }

    // Vérifier si le service existe
    const service = dbQueries.getServiceById.get(serviceId) as any;
    if (!service) {
      return res.status(404).json({ ok: false, error: "Service non trouvé" });
    }

    // Chemin de l'image si uploadée
    const imagePath = req.file ? `/uploads/variants/${req.file.filename}` : null;

    const result = dbQueries.insertVariant.run(
      serviceId,
      name,
      description || null,
      parseInt(priceModifier, 10) || 0,
      imagePath,
      enabled ? 1 : 0,
      parseInt(order, 10) || 0
    );

    const newVariantId = result.lastInsertRowid;

    // Log d'audit
    createAuditLog({
      adminId: (req as any).user?.userId,
      adminUsername: (req as any).user?.username,
      action: 'CREATE',
      entityType: 'service',
      entityId: `variant-${newVariantId}`,
      newValue: { name, serviceId, priceModifier },
      description: `Création de la variante: ${name} pour le service ${service.name}`,
      ipAddress: req.ip || req.socket.remoteAddress
    });
    
    return res.json({ 
      ok: true, 
      variant: {
        id: newVariantId,
        serviceId: parseInt(serviceId, 10),
        name,
        description: description || null,
        priceModifier: parseInt(priceModifier, 10) || 0,
        imagePath,
        enabled,
        order: parseInt(order, 10) || 0,
      }
    });
  } catch (err: any) {
    console.error("Erreur lors de l'ajout de la variante:", err);
    // Supprimer le fichier uploadé en cas d'erreur
    if (req.file) {
      fs.unlinkSync(req.file.path);
    }
    return res.status(500).json({ ok: false, error: err.message || "Erreur serveur" });
  }
});

// PUT /api/admin/services/:serviceId/variants/:variantId - Modifier une variante
app.put("/api/admin/services/:serviceId/variants/:variantId", authenticateToken, upload.single('image'), (req, res) => {
  try {
    const { serviceId, variantId } = req.params;
    const { name, description, priceModifier, enabled, order } = req.body;
    
    if (!name) {
      return res.status(400).json({ ok: false, error: "Le nom est requis" });
    }

    // Vérifier si la variante existe
    const existing = dbQueries.getVariantById.get(variantId) as any;
    if (!existing) {
      return res.status(404).json({ ok: false, error: "Variante non trouvée" });
    }

    // Gérer l'image
    let imagePath = existing.image_path;
    if (req.file) {
      // Supprimer l'ancienne image si elle existe
      if (existing.image_path) {
        const oldImagePath = path.join(process.cwd(), "public", existing.image_path);
        if (fs.existsSync(oldImagePath)) {
          fs.unlinkSync(oldImagePath);
        }
      }
      imagePath = `/uploads/variants/${req.file.filename}`;
    }

    dbQueries.updateVariant.run(
      name,
      description || null,
      parseInt(priceModifier, 10) || 0,
      imagePath,
      enabled ? 1 : 0,
      parseInt(order, 10) || 0,
      variantId
    );

    // Log d'audit
    createAuditLog({
      adminId: (req as any).user?.userId,
      adminUsername: (req as any).user?.username,
      action: 'UPDATE',
      entityType: 'service',
      entityId: `variant-${variantId}`,
      oldValue: { name: existing.name, priceModifier: existing.price_modifier },
      newValue: { name, priceModifier },
      description: `Modification de la variante: ${name}`,
      ipAddress: req.ip || req.socket.remoteAddress
    });
    
    return res.json({ ok: true });
  } catch (err: any) {
    console.error("Erreur lors de la modification de la variante:", err);
    // Supprimer le fichier uploadé en cas d'erreur
    if (req.file) {
      fs.unlinkSync(req.file.path);
    }
    return res.status(500).json({ ok: false, error: err.message || "Erreur serveur" });
  }
});

// DELETE /api/admin/services/:serviceId/variants/:variantId - Supprimer une variante
app.delete("/api/admin/services/:serviceId/variants/:variantId", authenticateToken, (req, res) => {
  try {
    const { variantId } = req.params;
    
    // Vérifier si la variante existe
    const existing = dbQueries.getVariantById.get(variantId) as any;
    if (!existing) {
      return res.status(404).json({ ok: false, error: "Variante non trouvée" });
    }

    // Supprimer l'image si elle existe
    if (existing.image_path) {
      const imagePath = path.join(process.cwd(), "public", existing.image_path);
      if (fs.existsSync(imagePath)) {
        fs.unlinkSync(imagePath);
      }
    }

    dbQueries.deleteVariant.run(variantId);

    // Log d'audit
    createAuditLog({
      adminId: (req as any).user?.userId,
      adminUsername: (req as any).user?.username,
      action: 'DELETE',
      entityType: 'service',
      entityId: `variant-${variantId}`,
      oldValue: { name: existing.name },
      description: `Suppression de la variante: ${existing.name}`,
      ipAddress: req.ip || req.socket.remoteAddress
    });
    
    return res.json({ ok: true });
  } catch (err) {
    console.error("Erreur lors de la suppression de la variante:", err);
    return res.status(500).json({ ok: false, error: "Erreur serveur" });
  }
});

// POST /api/stripe/create-checkout-session - Créer une session de paiement Stripe
app.post("/api/stripe/create-checkout-session", async (req, res) => {
  if (!stripe) {
    return res.status(503).json({ ok: false, error: "Stripe non configuré" });
  }

  try {
    const { type, id, serviceId, variantId, bookingData } = req.body;
    // type: "booking" ou "quote"
    // id: bookingId ou quoteId (optionnel si bookingData est fourni)
    // variantId: ID de la variante sélectionnée (optionnel)
    // bookingData: données de réservation (pour créer la réservation après paiement)

    if (!type || !serviceId) {
      return res.status(400).json({ ok: false, error: "type et serviceId sont requis" });
    }

    // Récupérer le service pour obtenir le stripe_product_id
    const service = dbQueries.getServiceByServiceId.get(serviceId) as any;
    if (!service || !service.stripe_product_id) {
      return res.status(400).json({ ok: false, error: "Service non trouvé ou non configuré pour Stripe" });
    }

    // Récupérer la variante si spécifiée et calculer le prix total
    let variant: any = null;
    let totalPrice = service.price || 0;
    
    if (variantId) {
      variant = dbQueries.getVariantById.get(variantId) as any;
      if (!variant || variant.service_id !== service.id) {
        return res.status(400).json({ ok: false, error: "Variante non trouvée ou ne correspond pas au service" });
      }
      // Ajouter le modificateur de prix de la variante
      totalPrice += (variant.price_modifier || 0);
    }

    // Récupérer les informations du client
    let customerInfo: any;
    if (type === "booking") {
      if (bookingData) {
        // Utiliser les données fournies directement (nouveau flux)
        customerInfo = bookingData;
      } else if (id) {
        // Ancien flux : récupérer depuis la BDD
        customerInfo = dbQueries.getBookingById.get(id) as any;
        if (!customerInfo) {
          return res.status(404).json({ ok: false, error: "Réservation non trouvée" });
        }
      } else {
        return res.status(400).json({ ok: false, error: "id ou bookingData requis pour type=booking" });
      }
    } else if (type === "quote") {
      if (!id) {
        return res.status(400).json({ ok: false, error: "id requis pour type=quote" });
      }
      customerInfo = dbQueries.getQuoteById.get(id) as any;
      if (!customerInfo) {
        return res.status(404).json({ ok: false, error: "Devis non trouvé" });
      }
    } else {
      return res.status(400).json({ ok: false, error: "Type invalide" });
    }

    // Vérifier la date limite de la ville (si renseignée)
    if (type === "booking" && customerInfo.city && customerInfo.preferredDate) {
      const cityData = dbQueries.checkServiceCity.get(customerInfo.city) as any;
      if (cityData && cityData.cutoff_date) {
        const cutoffDate = new Date(cityData.cutoff_date);
        const requestedDate = new Date(customerInfo.preferredDate);
        
        if (requestedDate > cutoffDate) {
          return res.status(400).json({ 
            ok: false, 
            error: `Les réservations pour ${customerInfo.city} sont fermées au-delà du ${cutoffDate.toLocaleDateString('fr-FR')}`
          });
        }
      }
    }

    // Récupérer le produit Stripe pour obtenir les prix
    const prices = await stripe.prices.list({ product: service.stripe_product_id, active: true });
    
    if (prices.data.length === 0) {
      return res.status(400).json({ ok: false, error: "Aucun prix configuré pour ce produit dans Stripe" });
    }

    // Utiliser le premier prix disponible
    const priceId = prices.data[0].id;

    // Préparer les métadonnées
    const sessionMetadata: any = {
      type,
      serviceId,
    };
    
    // Ajouter la variante si spécifiée
    if (variantId) {
      sessionMetadata.variantId = String(variantId);
    }
    
    if (type === "booking" && bookingData) {
      // Nouveau flux : stocker toutes les données dans les métadonnées
      sessionMetadata.bookingName = String(bookingData.name || "");
      sessionMetadata.bookingEmail = String(bookingData.email || "");
      sessionMetadata.bookingPhone = String(bookingData.phone || "");
      sessionMetadata.bookingCity = String(bookingData.city || "");
      sessionMetadata.bookingAddress = String(bookingData.address || "");
      sessionMetadata.bookingPostalCode = String(bookingData.postalCode || "");
      sessionMetadata.bookingServiceType = String(bookingData.serviceType || "");
      sessionMetadata.bookingBinCount = String(bookingData.binCount || "");
      sessionMetadata.bookingPreferredDate = String(bookingData.preferredDate || "");
      sessionMetadata.bookingPreferredTime = String(bookingData.preferredTime || "");
      sessionMetadata.bookingMessage = String(bookingData.message || "");
      sessionMetadata.bookingRgpdConsent = String(bookingData.rgpdConsent || "false");
      sessionMetadata.bookingMarketingConsent = String(bookingData.marketingConsent || "false");
      sessionMetadata.bookingSubscriptionContractConsent = String(bookingData.subscriptionContractConsent || "false");
      console.log(`📥 Métadonnées de réservation préparées:`, sessionMetadata);
    } else if (type === "booking" && id) {
      // Ancien flux : utiliser l'id existant
      sessionMetadata.bookingId = id.toString();
    } else if (type === "quote" && id) {
      sessionMetadata.quoteId = id.toString();
    }
    
    // Créer la session Stripe Checkout
    // Si une variante modifie le prix, on utilise le prix personnalisé
    const sessionConfig: any = {
      payment_method_types: ["card"],
      mode: "payment",
      success_url: `${baseUrl}/paiement-reussi?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/paiement-annule`,
      customer_email: customerInfo.email,
      metadata: sessionMetadata,
    };

    // Si le prix total diffère du prix de base, utiliser un prix personnalisé
    if (variant && variant.price_modifier && variant.price_modifier !== 0) {
      sessionConfig.line_items = [
        {
          price_data: {
            currency: 'eur',
            product: service.stripe_product_id,
            unit_amount: totalPrice, // Prix en centimes
          },
          quantity: 1,
        },
      ];
    } else {
      // Utiliser le prix Stripe par défaut
      sessionConfig.line_items = [
        {
          price: priceId,
          quantity: 1,
        },
      ];
    }

    const session = await stripe.checkout.sessions.create(sessionConfig);
    
    console.log(`✅ Session Stripe créée: ${session.id}`);
    console.log(`📥 Métadonnées envoyées à Stripe:`, JSON.stringify(sessionMetadata, null, 2));

    // Si c'est une réservation existante (ancien flux), mettre à jour le stripe_session_id
    // Sinon, la réservation sera créée après paiement
    if (type === "booking" && id && !bookingData) {
      dbQueries.updateBookingPayment.run(null, session.id, "unpaid", id);
    } else if (type === "quote" && id) {
      dbQueries.updateQuotePayment.run(null, session.id, "unpaid", id);
    }

    return res.json({ ok: true, sessionId: session.id, url: session.url });
  } catch (err: any) {
    console.error("Erreur lors de la création de la session Stripe:", err);
    return res.status(500).json({ ok: false, error: err.message || "Erreur serveur" });
  }
});

// ===== ENDPOINTS RGPD =====

// GET /api/admin/rgpd/client-data - Récupérer toutes les données d'un client
app.get("/api/admin/rgpd/client-data", authenticateToken, requireAdmin, (req, res) => {
  try {
    const { email } = req.query;
    
    if (!email || typeof email !== 'string') {
      return res.status(400).json({ ok: false, error: "Email requis" });
    }

    // Récupérer toutes les réservations
    const bookings = db.prepare("SELECT * FROM bookings WHERE email = ?").all(email);
    
    // Récupérer tous les devis
    const quotes = db.prepare("SELECT * FROM quotes WHERE email = ?").all(email);

    return res.json({
      ok: true,
      data: {
        email,
        bookings,
        quotes,
        totalRecords: bookings.length + quotes.length,
      }
    });
  } catch (err) {
    console.error("Erreur lors de la récupération des données client:", err);
    return res.status(500).json({ ok: false, error: "Erreur serveur" });
  }
});

// GET /api/admin/rgpd/export - Exporter les données d'un client (droit à la portabilité)
app.get("/api/admin/rgpd/export", authenticateToken, requireAdmin, (req, res) => {
  try {
    const { email } = req.query;
    const user = (req as any).user;
    
    if (!email || typeof email !== 'string') {
      return res.status(400).json({ ok: false, error: "Email requis" });
    }

    // Récupérer toutes les données
    const bookings = db.prepare("SELECT * FROM bookings WHERE email = ?").all(email);
    const quotes = db.prepare("SELECT * FROM quotes WHERE email = ?").all(email);

    const exportData = {
      metadata: {
        exportDate: new Date().toISOString(),
        email,
        dataController: "KBL CLEANNERS PRO",
        contact: "contact@kblcleanpro.fr",
      },
      personalData: {
        bookings,
        quotes,
      },
      rights: {
        info: "Conformément au RGPD, vous disposez des droits d'accès, de rectification, de suppression, de limitation, d'opposition et de portabilité de vos données personnelles.",
        contact: "Pour exercer vos droits, contactez-nous à : contact@kblcleanpro.fr"
      }
    };

    // Log d'audit
    createAuditLog({
      adminId: user?.id,
      adminUsername: user?.username,
      action: 'EXPORT',
      entityType: 'rgpd',
      entityId: email,
      description: `Export RGPD des données de ${email} (${bookings.length} réservations, ${quotes.length} devis)`,
      ipAddress: req.ip
    });

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="donnees-client-${email}-${new Date().toISOString().split('T')[0]}.json"`);
    return res.json(exportData);
  } catch (err) {
    console.error("Erreur lors de l'export des données:", err);
    return res.status(500).json({ ok: false, error: "Erreur serveur" });
  }
});

// DELETE /api/admin/rgpd/delete - Supprimer toutes les données d'un client (droit à l'effacement)
app.delete("/api/admin/rgpd/delete", authenticateToken, requireAdmin, (req, res) => {
  try {
    const { email } = req.body;
    const user = (req as any).user;
    
    if (!email) {
      return res.status(400).json({ ok: false, error: "Email requis" });
    }

    // Compter les enregistrements avant suppression
    const bookingsCount = db.prepare("SELECT COUNT(*) as count FROM bookings WHERE email = ?").get(email) as any;
    const quotesCount = db.prepare("SELECT COUNT(*) as count FROM quotes WHERE email = ?").get(email) as any;

    // Supprimer les réservations
    db.prepare("DELETE FROM bookings WHERE email = ?").run(email);
    
    // Supprimer les devis
    db.prepare("DELETE FROM quotes WHERE email = ?").run(email);

    // Log d'audit
    createAuditLog({
      adminId: user?.id,
      adminUsername: user?.username,
      action: 'DELETE',
      entityType: 'rgpd',
      entityId: email,
      description: `Suppression RGPD de toutes les données de ${email} (${bookingsCount.count} réservations, ${quotesCount.count} devis supprimés)`,
      ipAddress: req.ip
    });

    console.log(`🗑️ Données RGPD supprimées pour ${email}: ${bookingsCount.count} réservations, ${quotesCount.count} devis`);
    
    return res.json({
      ok: true,
      deleted: {
        bookings: bookingsCount.count,
        quotes: quotesCount.count,
      }
    });
  } catch (err) {
    console.error("Erreur lors de la suppression des données:", err);
    return res.status(500).json({ ok: false, error: "Erreur serveur" });
  }
});

const port = parseInt(process.env.PORT || "3000", 10);
const server = app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`API listening on :${port}`);
  console.log(`📁 Articles directory: ${ARTICLES_DIR}`);
  if (stripe) {
    console.log(`💳 Stripe intégré (mode: ${stripeSecretKey?.startsWith("sk_live") ? "production" : "test"})`);
  } else {
    console.log(`⚠️ Stripe non configuré (STRIPE_SECRET_KEY manquant)`);
  }
});

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`❌ Port ${port} is already in use.`);
    console.error(`💡 Solutions:`);
    console.error(`   1. Kill the process using port ${port}:`);
    console.error(`      Windows: netstat -ano | findstr :${port} then taskkill /PID <PID> /F`);
    console.error(`      Or use: npx kill-port ${port}`);
    console.error(`   2. Use a different port by setting PORT environment variable:`);
    console.error(`      PORT=3001 npm start`);
    process.exit(1);
  } else {
    console.error('❌ Server error:', err);
    process.exit(1);
  }
});


