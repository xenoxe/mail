import "dotenv/config";
import express from "express";
import cors from "cors";
import nodemailer from "nodemailer";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { body, validationResult } from "express-validator";
import validator from "validator";

const app = express();

// Configuration Express
app.set("trust proxy", true);

// ============================================
// SÉCURITÉ - Headers HTTP
// ============================================
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", "data:", "https:"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

// ============================================
// CORS - Configuration restrictive
// ============================================
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",").map((origin: string) => origin.trim())
  : ["http://localhost:3000", "http://localhost:5173"];

app.use(
  cors({
    origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
      // Autoriser les requêtes sans origine (mobile apps, Postman, etc.) si configuré
      if (!origin && process.env.ALLOW_NO_ORIGIN === "true") {
        return callback(null, true);
      }
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
    credentials: true,
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type", "Authorization", "X-API-Key"],
  })
);

// ============================================
// LIMITE DE TAILLE DU BODY
// ============================================
app.use(express.json({ limit: "1mb" })); // Limite à 1MB
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

// ============================================
// RATE LIMITING
// ============================================
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limite de 100 requêtes par IP toutes les 15 minutes
  message: {
    ok: false,
    error: "Trop de requêtes depuis cette IP, veuillez réessayer plus tard.",
  },
  standardHeaders: true,
  legacyHeaders: false,
});

const emailLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 heure
  max: 50, // Limite de 50 emails par IP par heure
  message: {
    ok: false,
    error: "Limite d'envoi d'emails atteinte. Veuillez réessayer dans une heure.",
  },
  standardHeaders: true,
  legacyHeaders: false,
});

app.use("/api/", generalLimiter);
app.use("/api/send", emailLimiter);
app.use("/api/send-template", emailLimiter);
app.use("/api/contact", emailLimiter);

// ============================================
// CONFIGURATION SMTP
// ============================================
const smtpHost = process.env.SMTP_HOST || "ssl0.ovh.net";
const smtpPort = parseInt(process.env.SMTP_PORT || "465", 10);
const smtpUser = process.env.SMTP_USER;
const smtpPass = process.env.SMTP_PASS;
const smtpFrom = process.env.SMTP_FROM || smtpUser;
const smtpTo = process.env.SMTP_TO || smtpUser;

// ============================================
// AUTHENTIFICATION API KEY
// ============================================
const API_KEYS = process.env.API_KEYS
  ? process.env.API_KEYS.split(",").map((key: string) => key.trim())
  : [];

// Middleware d'authentification par API key
const authenticateApiKey = (
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
) => {
  // Le endpoint /health est public
  if (req.path === "/health") {
    return next();
  }

  // Si aucune clé API n'est configurée, on autorise (mode développement)
  if (API_KEYS.length === 0) {
    console.warn("⚠️ Aucune clé API configurée - mode développement");
    return next();
  }

  // Récupérer la clé API depuis le header
  const apiKey = req.headers["x-api-key"] || req.headers["authorization"]?.replace("Bearer ", "");

  if (!apiKey) {
    return res.status(401).json({
      ok: false,
      error: "Clé API manquante. Utilisez le header 'X-API-Key' ou 'Authorization: Bearer <key>'",
    });
  }

  if (!API_KEYS.includes(apiKey as string)) {
    console.warn(`⚠️ Tentative d'accès avec une clé API invalide depuis ${req.ip}`);
    return res.status(403).json({
      ok: false,
      error: "Clé API invalide",
    });
  }

  next();
};

app.use("/api/", authenticateApiKey);

// Log de la configuration au démarrage
console.log("📧 Configuration SMTP:");
console.log(`   - Host: ${smtpHost || "Non défini"}`);
console.log(`   - Port: ${smtpPort} (${smtpPort === 465 ? "SSL" : smtpPort === 587 ? "STARTTLS" : "Autre"})`);
console.log(`   - User: ${smtpUser ? `${smtpUser.substring(0, 3)}***` : "Non défini"}`);
console.log(`   - Pass: ${smtpPass ? "***Défini***" : "Non défini"}`);
console.log(`   - From: ${smtpFrom || "Non défini"}`);
console.log(`   - To: ${smtpTo || "Non défini"}`);

console.log("🔐 Configuration sécurité:");
console.log(`   - API Keys configurées: ${API_KEYS.length > 0 ? `${API_KEYS.length} clé(s)` : "Aucune (mode dev)"}`);
console.log(`   - CORS Origins autorisés: ${allowedOrigins.join(", ")}`);
console.log(`   - Rate limiting: Activé (100 req/15min, 50 emails/heure)`);

if (!smtpUser || !smtpPass) {
  console.warn("⚠️ SMTP_USER/SMTP_PASS not set. Email sending will fail.");
} else {
  console.log("✅ Configuration SMTP complète");
}

// ============================================
// HELPERS
// ============================================

// Fonction helper pour créer un transporter SMTP
function createTransporter() {
  const isSecurePort = smtpPort === 465; // Port 465 = SSL, Port 587 = STARTTLS

  return nodemailer.createTransport({
    host: smtpHost,
    port: smtpPort,
    secure: isSecurePort,
    auth: {
      user: smtpUser,
      pass: smtpPass,
    },
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 15000,
    requireTLS: !isSecurePort && smtpPort === 587,
  });
}

// Fonction pour valider un email
function isValidEmail(email: string): boolean {
  return validator.isEmail(email);
}

// Fonction pour valider plusieurs emails
function validateEmails(emails: string | string[]): { valid: string[]; invalid: string[] } {
  const emailArray = Array.isArray(emails) ? emails : [emails];
  const valid: string[] = [];
  const invalid: string[] = [];

  emailArray.forEach((email) => {
    const trimmed = email.trim();
    if (isValidEmail(trimmed)) {
      valid.push(trimmed);
    } else {
      invalid.push(trimmed);
    }
  });

  return { valid, invalid };
}

// ============================================
// ROUTES
// ============================================

// GET /health - Route publique de santé
app.get("/health", (_req: express.Request, res: express.Response) => {
  res.json({
    status: "ok",
    service: "mail-service",
    timestamp: new Date().toISOString(),
    smtp: {
      configured: !!(smtpUser && smtpPass && smtpHost),
      host: smtpHost,
      port: smtpPort,
    },
    security: {
      apiKeyRequired: API_KEYS.length > 0,
      rateLimiting: true,
    },
  });
});

// POST /api/send - Envoi d'email simple
app.post(
  "/api/send",
  [
    body("to")
      .notEmpty()
      .withMessage("Le destinataire est requis")
      .custom((value) => {
        const emails = Array.isArray(value) ? value : [value];
        const { invalid } = validateEmails(emails);
        if (invalid.length > 0) {
          throw new Error(`Emails invalides: ${invalid.join(", ")}`);
        }
        return true;
      }),
    body("subject")
      .notEmpty()
      .withMessage("Le sujet est requis")
      .isLength({ max: 200 })
      .withMessage("Le sujet ne doit pas dépasser 200 caractères"),
    body("text").optional().isString().isLength({ max: 10000 }),
    body("html").optional().isString().isLength({ max: 50000 }),
    body("replyTo").optional().isEmail().withMessage("Reply-To doit être un email valide"),
    body("cc").optional().custom((value) => {
      if (!value) return true;
      const emails = Array.isArray(value) ? value : [value];
      const { invalid } = validateEmails(emails);
      if (invalid.length > 0) {
        throw new Error(`CC emails invalides: ${invalid.join(", ")}`);
      }
      return true;
    }),
    body("bcc").optional().custom((value) => {
      if (!value) return true;
      const emails = Array.isArray(value) ? value : [value];
      const { invalid } = validateEmails(emails);
      if (invalid.length > 0) {
        throw new Error(`BCC emails invalides: ${invalid.join(", ")}`);
      }
      return true;
    }),
  ],
  async (req: express.Request, res: express.Response) => {
    // Vérifier les erreurs de validation
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        ok: false,
        error: "Erreurs de validation",
        details: errors.array(),
      });
    }

    const { to, subject, text, html, replyTo, cc, bcc } = req.body;

    // Vérifier qu'au moins text ou html est fourni
    if (!text && !html) {
      return res.status(400).json({
        ok: false,
        error: "Au moins 'text' ou 'html' doit être fourni",
      });
    }

    // Vérifier la configuration SMTP
    if (!smtpHost || !smtpUser || !smtpPass) {
      console.warn("⚠️ Configuration SMTP incomplète - email non envoyé");
      return res.status(500).json({
        ok: false,
        error: "Configuration email incomplète",
      });
    }

    try {
      const transporter = createTransporter();

      const mailOptions: nodemailer.SendMailOptions = {
        from: smtpFrom || smtpUser,
        to: Array.isArray(to) ? to.join(", ") : to,
        subject,
        text,
        html,
        replyTo: replyTo || undefined,
        cc: cc ? (Array.isArray(cc) ? cc.join(", ") : cc) : undefined,
        bcc: bcc ? (Array.isArray(bcc) ? bcc.join(", ") : bcc) : undefined,
      };

      console.log("📧 Envoi d'email:", {
        to: mailOptions.to,
        subject,
        hasText: !!text,
        hasHtml: !!html,
        ip: req.ip,
      });

      const result = await transporter.sendMail(mailOptions);

      console.log("✅ Email envoyé avec succès:", {
        messageId: result.messageId,
        accepted: result.accepted,
        rejected: result.rejected,
      });

      return res.json({
        ok: true,
        messageId: result.messageId,
        accepted: result.accepted,
        rejected: result.rejected,
      });
    } catch (err: any) {
      console.error("❌ Erreur lors de l'envoi de l'email:", {
        message: err.message,
        code: err.code || "N/A",
        command: err.command || "N/A",
        response: err.response || "N/A",
        responseCode: err.responseCode || "N/A",
        ip: req.ip,
      });

      return res.status(500).json({
        ok: false,
        error: "Email send failed",
        message: err.message,
      });
    }
  }
);

// POST /api/send-template - Envoi d'email avec template
app.post(
  "/api/send-template",
  [
    body("to")
      .notEmpty()
      .withMessage("Le destinataire est requis")
      .custom((value) => {
        const emails = Array.isArray(value) ? value : [value];
        const { invalid } = validateEmails(emails);
        if (invalid.length > 0) {
          throw new Error(`Emails invalides: ${invalid.join(", ")}`);
        }
        return true;
      }),
    body("subject")
      .notEmpty()
      .withMessage("Le sujet est requis")
      .isLength({ max: 200 })
      .withMessage("Le sujet ne doit pas dépasser 200 caractères"),
    body("template").notEmpty().withMessage("Le template est requis").isLength({ max: 50000 }),
    body("data").optional().isObject(),
    body("replyTo").optional().isEmail().withMessage("Reply-To doit être un email valide"),
  ],
  async (req: express.Request, res: express.Response) => {
    // Vérifier les erreurs de validation
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        ok: false,
        error: "Erreurs de validation",
        details: errors.array(),
      });
    }

    const { to, subject, template, data, replyTo } = req.body;

    // Générer le texte et HTML à partir du template
    let text = template;
    let html = template;

    if (data) {
      Object.keys(data).forEach((key) => {
        const value = String(data[key]);
        text = text.replace(new RegExp(`{{${key}}}`, "g"), value);
        html = html.replace(new RegExp(`{{${key}}}`, "g"), value);
      });
    }

    // Vérifier la configuration SMTP
    if (!smtpHost || !smtpUser || !smtpPass) {
      console.warn("⚠️ Configuration SMTP incomplète - email non envoyé");
      return res.status(500).json({
        ok: false,
        error: "Configuration email incomplète",
      });
    }

    try {
      const transporter = createTransporter();

      const mailOptions: nodemailer.SendMailOptions = {
        from: smtpFrom || smtpUser,
        to: Array.isArray(to) ? to.join(", ") : to,
        subject,
        text,
        html,
        replyTo: replyTo || undefined,
      };

      console.log("📧 Envoi d'email avec template:", {
        to: mailOptions.to,
        subject,
        ip: req.ip,
      });

      const result = await transporter.sendMail(mailOptions);

      console.log("✅ Email envoyé avec succès:", {
        messageId: result.messageId,
        accepted: result.accepted,
        rejected: result.rejected,
      });

      return res.json({
        ok: true,
        messageId: result.messageId,
        accepted: result.accepted,
        rejected: result.rejected,
      });
    } catch (err: any) {
      console.error("❌ Erreur lors de l'envoi de l'email:", {
        message: err.message,
        code: err.code || "N/A",
        ip: req.ip,
      });

      return res.status(500).json({
        ok: false,
        error: "Email send failed",
        message: err.message,
      });
    }
  }
);

// POST /api/contact - Formulaire de contact
app.post(
  "/api/contact",
  [
    body("name")
      .notEmpty()
      .withMessage("Le nom est requis")
      .isLength({ min: 2, max: 100 })
      .withMessage("Le nom doit contenir entre 2 et 100 caractères")
      .trim()
      .escape(),
    body("email")
      .notEmpty()
      .withMessage("L'email est requis")
      .isEmail()
      .withMessage("Email invalide")
      .normalizeEmail(),
    body("phone")
      .optional()
      .isLength({ max: 20 })
      .withMessage("Le téléphone ne doit pas dépasser 20 caractères")
      .trim()
      .escape(),
    body("message")
      .notEmpty()
      .withMessage("Le message est requis")
      .isLength({ min: 10, max: 5000 })
      .withMessage("Le message doit contenir entre 10 et 5000 caractères")
      .trim()
      .escape(),
    body("subject").optional().isLength({ max: 200 }).trim().escape(),
  ],
  async (req: express.Request, res: express.Response) => {
    // Vérifier les erreurs de validation
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        ok: false,
        error: "Erreurs de validation",
        details: errors.array(),
      });
    }

    const { name, email, phone, message, subject: customSubject } = req.body;

    if (!smtpHost || !smtpUser || !smtpPass || !smtpTo) {
      console.warn("⚠️ Configuration SMTP incomplète - email non envoyé");
      return res.status(500).json({
        ok: false,
        error: "Configuration email incomplète",
      });
    }

    try {
      const transporter = createTransporter();

      const subject = customSubject || `💬 Nouveau message de contact – ${name}`;
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
        from: smtpFrom || smtpUser,
        to: smtpTo,
        replyTo: email,
        subject,
        text,
      });

      console.log("✅ Message de contact envoyé avec succès", { ip: req.ip });
      return res.json({ ok: true });
    } catch (err: any) {
      console.error("❌ Erreur lors de l'envoi du message:", {
        error: err,
        ip: req.ip,
      });
      return res.status(500).json({
        ok: false,
        error: "Email send failed",
        message: err.message,
      });
    }
  }
);

// ============================================
// GESTION DES ERREURS
// ============================================

// Gestion des erreurs 404
app.use((req: express.Request, res: express.Response) => {
  res.status(404).json({
    ok: false,
    error: "Route not found",
    path: req.path,
  });
});

// Gestion des erreurs globales
app.use((err: any, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("❌ Erreur serveur:", {
    error: err,
    path: req.path,
    ip: req.ip,
  });
  res.status(500).json({
    ok: false,
    error: "Internal server error",
    message: process.env.NODE_ENV === "production" ? "Une erreur est survenue" : err.message,
  });
});

// ============================================
// DÉMARRAGE DU SERVEUR
// ============================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Serveur mail-service démarré sur le port ${PORT}`);
  console.log(`📡 Endpoints disponibles:`);
  console.log(`   - GET  /health (public)`);
  console.log(`   - POST /api/send (protégé)`);
  console.log(`   - POST /api/send-template (protégé)`);
  console.log(`   - POST /api/contact (protégé)`);
  console.log(`\n🔐 Sécurité activée:`);
  console.log(`   - Authentification par API key`);
  console.log(`   - Rate limiting`);
  console.log(`   - Validation des entrées`);
  console.log(`   - Headers de sécurité (Helmet)`);
  console.log(`   - CORS restrictif`);
});
