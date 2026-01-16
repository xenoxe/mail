import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Chemin de la base de données
const dbPath = process.env.DB_PATH || path.join(process.cwd(), "data", "kblcleanpro.db");
const dbDir = path.dirname(dbPath);

// Créer le dossier data s'il n'existe pas
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
  console.log(`📁 Created database directory: ${dbDir}`);
}

// Initialiser la base de données
const db = new Database(dbPath);
db.pragma("journal_mode = WAL"); // Mode WAL pour de meilleures performances

console.log(`📦 Database initialized: ${dbPath}`);

// Créer les tables si elles n'existent pas
function initializeDatabase() {
  // Table des demandes de devis
  db.exec(`
    CREATE TABLE IF NOT EXISTS quotes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      phone TEXT NOT NULL,
      city TEXT NOT NULL,
      address TEXT,
      postal_code TEXT,
      service_type TEXT NOT NULL,
      bin_count INTEGER,
      message TEXT,
      status TEXT DEFAULT 'pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Table des réservations
  db.exec(`
    CREATE TABLE IF NOT EXISTS bookings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      phone TEXT NOT NULL,
      city TEXT NOT NULL,
      service_type TEXT NOT NULL,
      bin_count INTEGER,
      preferred_date DATE NOT NULL,
      preferred_time TIME NOT NULL,
      message TEXT,
      status TEXT DEFAULT 'pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      address TEXT,
      postal_code TEXT,
      stripe_payment_intent_id TEXT,
      stripe_session_id TEXT,
      payment_status TEXT DEFAULT 'unpaid',
      UNIQUE(preferred_date, preferred_time)
    )
  `);

  // Table des utilisateurs admin
  db.exec(`
    CREATE TABLE IF NOT EXISTS admins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      full_name TEXT,
      role TEXT DEFAULT 'operator',
      is_active BOOLEAN DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Table des tokens de réinitialisation de mot de passe
  db.exec(`
    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      admin_id INTEGER NOT NULL,
      token TEXT UNIQUE NOT NULL,
      expires_at DATETIME NOT NULL,
      used BOOLEAN DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (admin_id) REFERENCES admins(id) ON DELETE CASCADE
    )
  `);

  // Table des logs d'audit
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      admin_id INTEGER,
      admin_username TEXT,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT,
      old_value TEXT,
      new_value TEXT,
      description TEXT,
      ip_address TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (admin_id) REFERENCES admins(id) ON DELETE SET NULL
    )
  `);

  // Index pour les performances des logs
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_audit_logs_admin ON audit_logs(admin_id);
    CREATE INDEX IF NOT EXISTS idx_audit_logs_entity ON audit_logs(entity_type, entity_id);
    CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action);
  `);

  // Migration RGPD: Ajouter les colonnes de consentement à la table bookings
  const bookingColumns = (db.pragma("table_info(bookings)") as any[]).map((col: any) => col.name);
  
  if (!bookingColumns.includes("rgpd_consent")) {
    console.log("📝 RGPD: Ajout de la colonne 'rgpd_consent' à la table bookings");
    db.exec("ALTER TABLE bookings ADD COLUMN rgpd_consent BOOLEAN DEFAULT 0");
  }
  
  if (!bookingColumns.includes("marketing_consent")) {
    console.log("📝 RGPD: Ajout de la colonne 'marketing_consent' à la table bookings");
    db.exec("ALTER TABLE bookings ADD COLUMN marketing_consent BOOLEAN DEFAULT 0");
  }
  
  if (!bookingColumns.includes("consent_date")) {
    console.log("📝 RGPD: Ajout de la colonne 'consent_date' à la table bookings");
    db.exec("ALTER TABLE bookings ADD COLUMN consent_date DATETIME");
  }
  
  if (!bookingColumns.includes("consent_ip")) {
    console.log("📝 RGPD: Ajout de la colonne 'consent_ip' à la table bookings");
    db.exec("ALTER TABLE bookings ADD COLUMN consent_ip TEXT");
  }
  
  if (!bookingColumns.includes("subscription_contract_consent")) {
    console.log("📝 ABONNEMENT: Ajout de la colonne 'subscription_contract_consent' à la table bookings");
    db.exec("ALTER TABLE bookings ADD COLUMN subscription_contract_consent BOOLEAN DEFAULT 0");
  }
  
  if (!bookingColumns.includes("subscription_contract_date")) {
    console.log("📝 ABONNEMENT: Ajout de la colonne 'subscription_contract_date' à la table bookings");
    db.exec("ALTER TABLE bookings ADD COLUMN subscription_contract_date DATETIME");
  }

  // Migration RGPD: Ajouter les colonnes de consentement à la table quotes
  const quoteColumns = (db.pragma("table_info(quotes)") as any[]).map((col: any) => col.name);
  
  if (!quoteColumns.includes("rgpd_consent")) {
    console.log("📝 RGPD: Ajout de la colonne 'rgpd_consent' à la table quotes");
    db.exec("ALTER TABLE quotes ADD COLUMN rgpd_consent BOOLEAN DEFAULT 0");
  }
  
  if (!quoteColumns.includes("marketing_consent")) {
    console.log("📝 RGPD: Ajout de la colonne 'marketing_consent' à la table quotes");
    db.exec("ALTER TABLE quotes ADD COLUMN marketing_consent BOOLEAN DEFAULT 0");
  }
  
  if (!quoteColumns.includes("consent_date")) {
    console.log("📝 RGPD: Ajout de la colonne 'consent_date' à la table quotes");
    db.exec("ALTER TABLE quotes ADD COLUMN consent_date DATETIME");
  }
  
  if (!quoteColumns.includes("consent_ip")) {
    console.log("📝 RGPD: Ajout de la colonne 'consent_ip' à la table quotes");
    db.exec("ALTER TABLE quotes ADD COLUMN consent_ip TEXT");
  }

  // Migration: Ajouter les colonnes role, full_name, is_active et updated_at si elles n'existent pas
  const adminColumns = (db.pragma("table_info(admins)") as any[]).map((col: any) => col.name);
  
  if (!adminColumns.includes("role")) {
    console.log("📝 Ajout de la colonne 'role' à la table admins");
    db.exec("ALTER TABLE admins ADD COLUMN role TEXT DEFAULT 'operator'");
    // Mettre à jour les admins existants pour qu'ils soient superadmin
    db.exec("UPDATE admins SET role = 'superadmin' WHERE role IS NULL OR role = 'operator'");
  } else {
    // Migration : Convertir les anciens 'admin' en 'superadmin'
    try {
      const adminCount = db.prepare("SELECT COUNT(*) as count FROM admins WHERE role = 'admin'").get() as any;
      if (adminCount && adminCount.count > 0) {
        console.log("📝 Migration des admins vers superadmin");
        db.exec("UPDATE admins SET role = 'superadmin' WHERE role = 'admin'");
      }
    } catch (err: any) {
      console.warn("⚠️ Erreur lors de la migration admin->superadmin:", err.message);
    }
  }
  
  if (!adminColumns.includes("full_name")) {
    console.log("📝 Ajout de la colonne 'full_name' à la table admins");
    db.exec("ALTER TABLE admins ADD COLUMN full_name TEXT");
  }
  
  if (!adminColumns.includes("is_active")) {
    console.log("📝 Ajout de la colonne 'is_active' à la table admins");
    db.exec("ALTER TABLE admins ADD COLUMN is_active BOOLEAN DEFAULT 1");
  }
  
  if (!adminColumns.includes("updated_at")) {
    console.log("📝 Ajout de la colonne 'updated_at' à la table admins");
    db.exec("ALTER TABLE admins ADD COLUMN updated_at DATETIME");
    // Mettre à jour les lignes existantes avec la date actuelle
    db.exec("UPDATE admins SET updated_at = CURRENT_TIMESTAMP WHERE updated_at IS NULL");
  }

  // Table de configuration
  db.exec(`
    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Table des villes d'intervention
  db.exec(`
    CREATE TABLE IF NOT EXISTS service_cities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      city_name TEXT UNIQUE NOT NULL,
      postal_code TEXT,
      passage1_week INTEGER,
      passage1_day INTEGER,
      passage2_week INTEGER,
      passage2_day INTEGER,
      enabled BOOLEAN DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Table des services/prestations
  db.exec(`
    CREATE TABLE IF NOT EXISTS services (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      service_id TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      translation_key TEXT,
      stripe_product_id TEXT,
      price INTEGER DEFAULT 0,
      enabled BOOLEAN DEFAULT 1,
      display_order INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Index pour les performances
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_bookings_date ON bookings(preferred_date);
    CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings(status);
    CREATE INDEX IF NOT EXISTS idx_quotes_created ON quotes(created_at);
    CREATE INDEX IF NOT EXISTS idx_quotes_status ON quotes(status);
    CREATE INDEX IF NOT EXISTS idx_service_cities_enabled ON service_cities(enabled);
    CREATE INDEX IF NOT EXISTS idx_services_enabled ON services(enabled);
    CREATE INDEX IF NOT EXISTS idx_services_order ON services(display_order);
  `);

  // Migration : Ajouter les colonnes name et stripe_product_id à la table services (AVANT l'initialisation)
  try {
    const servicesColumns = db.prepare("PRAGMA table_info(services)").all() as any[];
    const servicesHasName = servicesColumns.some((col) => col.name === "name");
    const servicesHasStripeProductId = servicesColumns.some((col) => col.name === "stripe_product_id");
    const servicesHasPrice = servicesColumns.some((col) => col.name === "price");

    if (!servicesHasName) {
      db.exec(`ALTER TABLE services ADD COLUMN name TEXT`);
      console.log("✅ Colonne name ajoutée à la table services");
      
      // Mettre à jour les services existants avec des noms par défaut
      const updateServiceName = db.prepare(`
        UPDATE services SET name = ? WHERE service_id = ?
      `);
      updateServiceName.run("Nettoyage de poubelles", "cleaning");
      updateServiceName.run("Désinfection de poubelles", "disinfection");
      updateServiceName.run("Installation d'abris à poubelles", "shelters");
      updateServiceName.run("Maintenance et entretien", "maintenance");
      updateServiceName.run("Services pour copropriétés", "copropriety");
      updateServiceName.run("Services pour entreprises", "companies");
      console.log("✅ Noms par défaut ajoutés aux services existants");
    }

    if (!servicesHasStripeProductId) {
      db.exec(`ALTER TABLE services ADD COLUMN stripe_product_id TEXT`);
      console.log("✅ Colonne stripe_product_id ajoutée à la table services");
    }

    if (!servicesHasPrice) {
      db.exec(`ALTER TABLE services ADD COLUMN price INTEGER DEFAULT 0`);
      console.log("✅ Colonne price ajoutée à la table services (prix en centimes)");
    }
  } catch (err: any) {
    console.warn("⚠️ Erreur lors de la migration de services (name):", err.message);
  }

  // Migration : Ajouter les colonnes address et postal_code aux tables existantes
  try {
    // Vérifier si la colonne address existe dans quotes
    const quotesColumns = db.prepare("PRAGMA table_info(quotes)").all() as any[];
    const quotesHasAddress = quotesColumns.some((col) => col.name === "address");
    
    if (!quotesHasAddress) {
      db.exec(`ALTER TABLE quotes ADD COLUMN address TEXT`);
      db.exec(`ALTER TABLE quotes ADD COLUMN postal_code TEXT`);
      console.log("✅ Colonnes address et postal_code ajoutées à la table quotes");
    }
  } catch (err: any) {
    console.warn("⚠️ Erreur lors de la migration de quotes:", err.message);
  }

  try {
    // Vérifier si la colonne address existe dans bookings
    const bookingsColumns = db.prepare("PRAGMA table_info(bookings)").all() as any[];
    const bookingsHasAddress = bookingsColumns.some((col) => col.name === "address");
    
    if (!bookingsHasAddress) {
      db.exec(`ALTER TABLE bookings ADD COLUMN address TEXT`);
      db.exec(`ALTER TABLE bookings ADD COLUMN postal_code TEXT`);
      console.log("✅ Colonnes address et postal_code ajoutées à la table bookings");
    }
  } catch (err: any) {
    console.warn("⚠️ Erreur lors de la migration de bookings:", err.message);
  }

  // Migration : Ajouter les colonnes Stripe aux tables quotes et bookings
  try {
    const quotesColumns = db.prepare("PRAGMA table_info(quotes)").all() as any[];
    const quotesHasStripe = quotesColumns.some((col) => col.name === "stripe_payment_intent_id");

    if (!quotesHasStripe) {
      db.exec(`ALTER TABLE quotes ADD COLUMN stripe_payment_intent_id TEXT`);
      db.exec(`ALTER TABLE quotes ADD COLUMN stripe_session_id TEXT`);
      db.exec(`ALTER TABLE quotes ADD COLUMN payment_status TEXT DEFAULT 'unpaid'`);
      console.log("✅ Colonnes Stripe ajoutées à la table quotes");
    }
  } catch (err: any) {
    console.warn("⚠️ Erreur lors de la migration Stripe de quotes:", err.message);
  }

  try {
    const bookingsColumns = db.prepare("PRAGMA table_info(bookings)").all() as any[];
    const bookingsHasStripe = bookingsColumns.some((col) => col.name === "stripe_payment_intent_id");

    if (!bookingsHasStripe) {
      db.exec(`ALTER TABLE bookings ADD COLUMN stripe_payment_intent_id TEXT`);
      db.exec(`ALTER TABLE bookings ADD COLUMN stripe_session_id TEXT`);
      db.exec(`ALTER TABLE bookings ADD COLUMN payment_status TEXT DEFAULT 'unpaid'`);
      console.log("✅ Colonnes Stripe ajoutées à la table bookings");
    }
  } catch (err: any) {
    console.warn("⚠️ Erreur lors de la migration Stripe de bookings:", err.message);
  }

  // Migration : Ajouter les colonnes de passage (semaine + jour) à la table service_cities
  try {
    const citiesColumns = db.prepare("PRAGMA table_info(service_cities)").all() as any[];
    const citiesHasPassage1Week = citiesColumns.some((col) => col.name === "passage1_week");

    if (!citiesHasPassage1Week) {
      // Nouvelles colonnes pour les passages mensuels
      db.exec(`ALTER TABLE service_cities ADD COLUMN passage1_week INTEGER`);
      db.exec(`ALTER TABLE service_cities ADD COLUMN passage1_day INTEGER`);
      db.exec(`ALTER TABLE service_cities ADD COLUMN passage2_week INTEGER`);
      db.exec(`ALTER TABLE service_cities ADD COLUMN passage2_day INTEGER`);
      console.log("✅ Colonnes de passage mensuel ajoutées à la table service_cities");
      
      // Migration des anciennes colonnes si elles existent
      const hasOldColumns = citiesColumns.some((col) => col.name === "passage_day1");
      if (hasOldColumns) {
        console.log("⚠️ Anciennes colonnes passage_day1/2 détectées - migration manuelle recommandée");
      }
    }
  } catch (err: any) {
    console.warn("⚠️ Erreur lors de la migration de service_cities (passages mensuels):", err.message);
  }

  // Migration : Ajouter la colonne cutoff_date à la table service_cities
  try {
    const citiesColumns = db.prepare("PRAGMA table_info(service_cities)").all() as any[];
    const citiesHasCutoffDate = citiesColumns.some((col) => col.name === "cutoff_date");

    if (!citiesHasCutoffDate) {
      db.exec(`ALTER TABLE service_cities ADD COLUMN cutoff_date DATE`);
      console.log("✅ Colonne cutoff_date ajoutée à la table service_cities");
    }
  } catch (err: any) {
    console.warn("⚠️ Erreur lors de l'ajout de cutoff_date à service_cities:", err.message);
  }

  // Migration : Ajouter les colonnes de passage (semaine + jour) à la table services
  try {
    const servicesColumns = db.prepare("PRAGMA table_info(services)").all() as any[];
    const servicesHasPassage1Week = servicesColumns.some((col) => col.name === "passage1_week");

    if (!servicesHasPassage1Week) {
      // Nouvelles colonnes pour les passages mensuels des services
      db.exec(`ALTER TABLE services ADD COLUMN passage1_week INTEGER`);
      db.exec(`ALTER TABLE services ADD COLUMN passage1_day INTEGER`);
      db.exec(`ALTER TABLE services ADD COLUMN passage2_week INTEGER`);
      db.exec(`ALTER TABLE services ADD COLUMN passage2_day INTEGER`);
      console.log("✅ Colonnes de passage mensuel ajoutées à la table services");
    }
  } catch (err: any) {
    console.warn("⚠️ Erreur lors de la migration de services (passages mensuels):", err.message);
  }

  // Migration : Ajouter la colonne max_bookings_per_day à la table services
  try {
    const servicesColumns = db.prepare("PRAGMA table_info(services)").all() as any[];
    const servicesHasMaxBookings = servicesColumns.some((col) => col.name === "max_bookings_per_day");

    if (!servicesHasMaxBookings) {
      db.exec(`ALTER TABLE services ADD COLUMN max_bookings_per_day INTEGER`);
      console.log("✅ Colonne max_bookings_per_day ajoutée à la table services");
    }
  } catch (err: any) {
    console.warn("⚠️ Erreur lors de la migration de services (max_bookings_per_day):", err.message);
  }

  // Migration : Corriger la contrainte NOT NULL sur translation_key
  try {
    const servicesColumns = db.prepare("PRAGMA table_info(services)").all() as any[];
    const translationKeyColumn = servicesColumns.find((col: any) => col.name === "translation_key");
    
    // Si translation_key existe et a une contrainte NOT NULL (notnull = 1), on doit recréer la table
    if (translationKeyColumn && translationKeyColumn.notnull === 1) {
      console.log("⚠️ Migration nécessaire: translation_key a une contrainte NOT NULL incorrecte");
      
      // Créer une nouvelle table avec le bon schéma
      db.exec(`
        CREATE TABLE services_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          service_id TEXT UNIQUE NOT NULL,
          name TEXT NOT NULL,
          translation_key TEXT,
          stripe_product_id TEXT,
          price INTEGER DEFAULT 0,
          enabled BOOLEAN DEFAULT 1,
          display_order INTEGER DEFAULT 0,
          passage1_week INTEGER,
          passage1_day INTEGER,
          passage2_week INTEGER,
          passage2_day INTEGER,
          max_bookings_per_day INTEGER,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);
      
      // Copier les données existantes
      db.exec(`
        INSERT INTO services_new (id, service_id, name, translation_key, stripe_product_id, price, enabled, display_order, passage1_week, passage1_day, passage2_week, passage2_day, max_bookings_per_day, created_at, updated_at)
        SELECT id, service_id, name, translation_key, stripe_product_id, price, enabled, display_order, passage1_week, passage1_day, passage2_week, passage2_day, max_bookings_per_day, created_at, updated_at
        FROM services
      `);
      
      // Supprimer l'ancienne table
      db.exec(`DROP TABLE services`);
      
      // Renommer la nouvelle table
      db.exec(`ALTER TABLE services_new RENAME TO services`);
      
      // Recréer l'index
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_services_enabled ON services(enabled);
        CREATE INDEX IF NOT EXISTS idx_services_order ON services(display_order);
      `);
      
      console.log("✅ Table services recréée avec translation_key nullable");
    }
  } catch (err: any) {
    console.warn("⚠️ Erreur lors de la migration de services (translation_key nullable):", err.message);
  }

  // Migration : Ajouter les colonnes is_subscription, information et contract_url pour les abonnements
  try {
    const servicesColumns = db.prepare("PRAGMA table_info(services)").all() as any[];
    const servicesHasIsSubscription = servicesColumns.some((col) => col.name === "is_subscription");
    const servicesHasInformation = servicesColumns.some((col) => col.name === "information");
    const servicesHasContractUrl = servicesColumns.some((col) => col.name === "contract_url");

    if (!servicesHasIsSubscription) {
      db.exec(`ALTER TABLE services ADD COLUMN is_subscription BOOLEAN DEFAULT 0`);
      console.log("✅ Colonne is_subscription ajoutée à la table services");
    }

    if (!servicesHasInformation) {
      db.exec(`ALTER TABLE services ADD COLUMN information TEXT`);
      console.log("✅ Colonne information ajoutée à la table services");
    }

    if (!servicesHasContractUrl) {
      db.exec(`ALTER TABLE services ADD COLUMN contract_url TEXT`);
      console.log("✅ Colonne contract_url ajoutée à la table services");
    }
  } catch (err: any) {
    console.warn("⚠️ Erreur lors de la migration de services (abonnements):", err.message);
  }

  // Table des variantes de services (ex: couleurs d'abris)
  db.exec(`
    CREATE TABLE IF NOT EXISTS service_variants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      service_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      price_modifier INTEGER DEFAULT 0,
      image_path TEXT,
      enabled BOOLEAN DEFAULT 1,
      display_order INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (service_id) REFERENCES services(id) ON DELETE CASCADE
    )
  `);

  // Index pour les performances des variantes
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_service_variants_service ON service_variants(service_id);
    CREATE INDEX IF NOT EXISTS idx_service_variants_enabled ON service_variants(enabled);
    CREATE INDEX IF NOT EXISTS idx_service_variants_order ON service_variants(display_order);
  `);

  // Migration : Ajouter la colonne variant_id à la table bookings
  try {
    const bookingsColumns = db.prepare("PRAGMA table_info(bookings)").all() as any[];
    const bookingsHasVariantId = bookingsColumns.some((col) => col.name === "variant_id");

    if (!bookingsHasVariantId) {
      db.exec(`ALTER TABLE bookings ADD COLUMN variant_id INTEGER`);
      console.log("✅ Colonne variant_id ajoutée à la table bookings");
    }
  } catch (err: any) {
    console.warn("⚠️ Erreur lors de la migration de bookings (variant_id):", err.message);
  }

  // ⚠️ Initialisation automatique des services DÉSACTIVÉE
  // Les services sont maintenant gérés manuellement depuis l'interface admin
  // Pour réactiver l'initialisation automatique, décommentez les lignes ci-dessous
  
  /*
  // Initialiser les services par défaut (APRÈS TOUTES les migrations)
  const insertService = db.prepare(`
    INSERT OR IGNORE INTO services (service_id, name, translation_key, stripe_product_id, price, enabled, display_order, passage1_week, passage1_day, passage2_week, passage2_day, max_bookings_per_day, is_subscription, information) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  // Services ponctuels
  insertService.run("cleaning", "Nettoyage de poubelles", "cleaning", null, 5000, 1, 1, null, null, null, null, null, 0, null); // 50€
  insertService.run("disinfection", "Désinfection de poubelles", "disinfection", null, 7500, 1, 2, null, null, null, null, null, 0, null); // 75€
  insertService.run("shelters", "Installation d'abris à poubelles", "shelters", null, 25000, 1, 3, null, null, null, null, null, 0, null); // 250€
  insertService.run("maintenance", "Maintenance et entretien", "maintenance", null, 10000, 1, 4, null, null, null, null, null, 0, null); // 100€
  insertService.run("copropriety", "Services pour copropriétés", "copropriety", null, 15000, 1, 5, null, null, null, null, null, 0, null); // 150€
  insertService.run("companies", "Services pour entreprises", "companies", null, 20000, 1, 6, null, null, null, null, null, 0, null); // 200€
  
  // Abonnements
  insertService.run("premium", "Abonnement Premium", "premium", null, 4000, 1, 7, null, null, null, null, null, 1, "1 passage par mois selon les dates de passage liées à votre ville. Les dates sont automatiquement planifiées selon le calendrier municipal."); // 40€/mois
  insertService.run("premium_plus", "Abonnement Premium+", "premium_plus", null, 7000, 1, 8, null, null, null, null, null, 1, "2 passages par mois selon les dates de passage liées à votre ville. Les dates sont automatiquement planifiées selon le calendrier municipal."); // 70€/mois
  */

  // Initialiser les valeurs par défaut de configuration
  const insertConfig = db.prepare(`
    INSERT OR IGNORE INTO config (key, value) VALUES (?, ?)
  `);
  insertConfig.run("quotes_enabled", "false");
  insertConfig.run("max_bookings_per_day", "25"); // Limite par défaut : 5 réservations par jour
  insertConfig.run("time_selection_enabled", "false"); // Par défaut, l'heure est activée
  insertConfig.run("languages_enabled", "false"); // Par défaut, les langues sont activées

  console.log("✅ Database tables initialized");
}

// Initialiser au démarrage
initializeDatabase();

// Types TypeScript
export interface Quote {
  id: number;
  name: string;
  email: string;
  phone: string;
  city: string;
  service_type: string;
  bin_count: number | null;
  message: string | null;
  status: "pending" | "contacted" | "converted" | "cancelled";
  created_at: string;
  updated_at: string;
}

export interface Booking {
  id: number;
  name: string;
  email: string;
  phone: string;
  city: string;
  service_type: string;
  bin_count: number | null;
  preferred_date: string;
  preferred_time: string;
  message: string | null;
  status: "pending" | "confirmed" | "completed" | "cancelled";
  created_at: string;
  updated_at: string;
}

// Requêtes préparées
export const dbQueries = {
  // Quotes
  insertQuote: db.prepare(`
    INSERT INTO quotes (name, email, phone, city, address, postal_code, service_type, bin_count, message, rgpd_consent, marketing_consent, consent_date, consent_ip)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  
  getQuotes: db.prepare(`
    SELECT * FROM quotes ORDER BY created_at DESC
  `),
  
  getQuoteById: db.prepare(`
    SELECT * FROM quotes WHERE id = ?
  `),
  
  updateQuoteStatus: db.prepare(`
    UPDATE quotes SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `),

  // Bookings
  insertBooking: db.prepare(`
    INSERT INTO bookings (name, email, phone, city, address, postal_code, service_type, bin_count, preferred_date, preferred_time, message, stripe_session_id, payment_status, rgpd_consent, marketing_consent, consent_date, consent_ip, variant_id, subscription_contract_consent, subscription_contract_date)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  
  getBookings: db.prepare(`
    SELECT 
      bookings.*,
      services.name as service_name,
      service_variants.name as variant_name,
      service_variants.description as variant_description,
      service_variants.image_path as variant_image_path,
      service_variants.price_modifier as variant_price_modifier
    FROM bookings
    LEFT JOIN services ON bookings.service_type = services.service_id
    LEFT JOIN service_variants ON bookings.variant_id = service_variants.id
    ORDER BY bookings.preferred_date ASC, bookings.preferred_time ASC
  `),
  
  getBookingById: db.prepare(`
    SELECT * FROM bookings WHERE id = ?
  `),
  
  getBookingsByDate: db.prepare(`
    SELECT 
      bookings.*,
      services.name as service_name,
      service_variants.name as variant_name,
      service_variants.description as variant_description,
      service_variants.image_path as variant_image_path,
      service_variants.price_modifier as variant_price_modifier
    FROM bookings
    LEFT JOIN services ON bookings.service_type = services.service_id
    LEFT JOIN service_variants ON bookings.variant_id = service_variants.id
    WHERE bookings.preferred_date = ?
    ORDER BY bookings.preferred_time ASC
  `),
  
  countBookingsByDate: db.prepare(`
    SELECT COUNT(*) as count FROM bookings 
    WHERE preferred_date = ? AND status != 'cancelled'
  `),
  
  getBookingsByDateRange: db.prepare(`
    SELECT preferred_date, COUNT(*) as count 
    FROM bookings 
    WHERE preferred_date >= ? AND preferred_date <= ? AND status != 'cancelled'
    GROUP BY preferred_date
  `),

  getBookingsByDateRangeAndService: db.prepare(`
    SELECT preferred_date, COUNT(*) as count 
    FROM bookings 
    WHERE preferred_date >= ? AND preferred_date <= ? AND service_type = ? AND status != 'cancelled'
    GROUP BY preferred_date
  `),
  
  // Compter uniquement les réservations payées (pour la limite)
  countPaidBookingsByDate: db.prepare(`
    SELECT COUNT(*) as count FROM bookings 
    WHERE preferred_date = ? AND status != 'cancelled' AND payment_status = 'paid'
  `),

  countPaidBookingsByDateAndService: db.prepare(`
    SELECT COUNT(*) as count FROM bookings 
    WHERE preferred_date = ? AND service_type = ? AND status != 'cancelled' AND payment_status = 'paid'
  `),

  countBookingsByDateAndService: db.prepare(`
    SELECT COUNT(*) as count FROM bookings 
    WHERE preferred_date = ? AND service_type = ? AND status != 'cancelled'
  `),
  
  getPaidBookingsByDateRange: db.prepare(`
    SELECT preferred_date, COUNT(*) as count 
    FROM bookings 
    WHERE preferred_date >= ? AND preferred_date <= ? AND status != 'cancelled' AND payment_status = 'paid'
    GROUP BY preferred_date
  `),

  getPaidBookingsByDateRangeAndService: db.prepare(`
    SELECT preferred_date, COUNT(*) as count 
    FROM bookings 
    WHERE preferred_date >= ? AND preferred_date <= ? AND service_type = ? AND status != 'cancelled' AND payment_status = 'paid'
    GROUP BY preferred_date
  `),
  
  updateBookingStatus: db.prepare(`
    UPDATE bookings SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `),
  
  updateBookingPayment: db.prepare(`
    UPDATE bookings SET stripe_payment_intent_id = ?, stripe_session_id = ?, payment_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `),
  
  updateQuotePayment: db.prepare(`
    UPDATE quotes SET stripe_payment_intent_id = ?, stripe_session_id = ?, payment_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `),
  
  getBookingByStripeSession: db.prepare(`
    SELECT * FROM bookings WHERE stripe_session_id = ?
  `),
  
  getQuoteByStripeSession: db.prepare(`
    SELECT * FROM quotes WHERE stripe_session_id = ?
  `),
  
  checkBookingConflict: db.prepare(`
    SELECT * FROM bookings WHERE preferred_date = ? AND preferred_time = ? AND status != 'cancelled'
  `),

  // Stats
  getStats: db.prepare(`
    SELECT 
      (SELECT COUNT(*) FROM quotes WHERE status = 'pending') as pending_quotes,
      (SELECT COUNT(*) FROM bookings WHERE status = 'pending') as pending_bookings,
      (SELECT COUNT(*) FROM bookings WHERE preferred_date >= date('now')) as upcoming_bookings,
      (SELECT COUNT(*) FROM quotes) as total_quotes,
      (SELECT COUNT(*) FROM bookings) as total_bookings
  `),

  // Services
  getAllServices: db.prepare(`
    SELECT * FROM services ORDER BY display_order ASC, id ASC
  `),
  
  getEnabledServices: db.prepare(`
    SELECT * FROM services WHERE enabled = 1 ORDER BY display_order ASC, id ASC
  `),
  
  getServiceById: db.prepare(`
    SELECT * FROM services WHERE id = ?
  `),
  
  getServiceByServiceId: db.prepare(`
    SELECT * FROM services WHERE service_id = ?
  `),
  
  insertService: db.prepare(`
    INSERT INTO services (service_id, name, translation_key, stripe_product_id, price, enabled, display_order, passage1_week, passage1_day, passage2_week, passage2_day, max_bookings_per_day, is_subscription, information, contract_url)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  
  updateService: db.prepare(`
    UPDATE services 
    SET service_id = ?, name = ?, translation_key = ?, stripe_product_id = ?, price = ?, enabled = ?, display_order = ?, passage1_week = ?, passage1_day = ?, passage2_week = ?, passage2_day = ?, max_bookings_per_day = ?, is_subscription = ?, information = ?, contract_url = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `),
  
  deleteService: db.prepare(`
    DELETE FROM services WHERE id = ?
  `),

  // Config
  getConfig: db.prepare(`
    SELECT value FROM config WHERE key = ?
  `),
  
  setConfig: db.prepare(`
    INSERT INTO config (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `),

  // Service Cities
  getServiceCities: db.prepare(`
    SELECT * FROM service_cities WHERE enabled = 1 ORDER BY city_name ASC
  `),
  
  getAllServiceCities: db.prepare(`
    SELECT * FROM service_cities ORDER BY city_name ASC
  `),
  
  addServiceCity: db.prepare(`
    INSERT INTO service_cities (city_name, postal_code, passage1_week, passage1_day, passage2_week, passage2_day, enabled, cutoff_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `),
  
  updateServiceCity: db.prepare(`
    UPDATE service_cities SET city_name = ?, postal_code = ?, passage1_week = ?, passage1_day = ?, passage2_week = ?, passage2_day = ?, enabled = ?, cutoff_date = ? WHERE id = ?
  `),
  
  deleteServiceCity: db.prepare(`
    DELETE FROM service_cities WHERE id = ?
  `),
  
  checkServiceCity: db.prepare(`
    SELECT * FROM service_cities WHERE city_name = ? AND enabled = 1
  `),

  // Admins / Users
  getAdminByUsername: db.prepare(`
    SELECT * FROM admins WHERE username = ?
  `),

  getAllAdmins: db.prepare(`
    SELECT id, username, full_name, role, is_active, created_at, updated_at FROM admins ORDER BY created_at DESC
  `),

  getAdminById: db.prepare(`
    SELECT id, username, full_name, role, is_active, created_at, updated_at FROM admins WHERE id = ?
  `),

  insertAdmin: db.prepare(`
    INSERT INTO admins (username, password_hash, full_name, role, is_active)
    VALUES (?, ?, ?, ?, ?)
  `),

  updateAdmin: db.prepare(`
    UPDATE admins SET username = ?, full_name = ?, role = ?, is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `),

  updateAdminPassword: db.prepare(`
    UPDATE admins SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `),

  deleteAdmin: db.prepare(`
    DELETE FROM admins WHERE id = ?
  `),

  countAdmins: db.prepare(`
    SELECT COUNT(*) as count FROM admins WHERE role IN ('admin', 'superadmin')
  `),

  // Password Reset Tokens
  createPasswordResetToken: db.prepare(`
    INSERT INTO password_reset_tokens (admin_id, token, expires_at)
    VALUES (?, ?, ?)
  `),

  getPasswordResetToken: db.prepare(`
    SELECT * FROM password_reset_tokens 
    WHERE token = ? AND used = 0 AND expires_at > datetime('now')
  `),

  markTokenAsUsed: db.prepare(`
    UPDATE password_reset_tokens SET used = 1 WHERE token = ?
  `),

  deleteExpiredTokens: db.prepare(`
    DELETE FROM password_reset_tokens WHERE expires_at < datetime('now')
  `),

  getAdminByEmail: db.prepare(`
    SELECT * FROM admins WHERE username = ?
  `),

  // Audit Logs
  createAuditLog: db.prepare(`
    INSERT INTO audit_logs (admin_id, admin_username, action, entity_type, entity_id, old_value, new_value, description, ip_address)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),

  getAuditLogs: db.prepare(`
    SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT ? OFFSET ?
  `),

  getAuditLogsByEntity: db.prepare(`
    SELECT * FROM audit_logs WHERE entity_type = ? AND entity_id = ? ORDER BY created_at DESC
  `),

  getAuditLogsByAdmin: db.prepare(`
    SELECT * FROM audit_logs WHERE admin_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?
  `),

  getAuditLogsByAction: db.prepare(`
    SELECT * FROM audit_logs WHERE action = ? ORDER BY created_at DESC LIMIT ? OFFSET ?
  `),

  getAuditLogsByActionAndAdmin: db.prepare(`
    SELECT * FROM audit_logs WHERE action = ? AND admin_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?
  `),

  countAuditLogs: db.prepare(`
    SELECT COUNT(*) as count FROM audit_logs
  `),

  countAuditLogsByAdmin: db.prepare(`
    SELECT COUNT(*) as count FROM audit_logs WHERE admin_id = ?
  `),

  countAuditLogsByAction: db.prepare(`
    SELECT COUNT(*) as count FROM audit_logs WHERE action = ?
  `),

  countAuditLogsByActionAndAdmin: db.prepare(`
    SELECT COUNT(*) as count FROM audit_logs WHERE action = ? AND admin_id = ?
  `),

  deleteAllAuditLogs: db.prepare(`
    DELETE FROM audit_logs
  `),

  deleteOldAuditLogs: db.prepare(`
    DELETE FROM audit_logs WHERE created_at < datetime('now', '-90 days')
  `),

  // Service Variants
  getVariantsByServiceId: db.prepare(`
    SELECT * FROM service_variants WHERE service_id = ? ORDER BY display_order ASC, id ASC
  `),
  
  getEnabledVariantsByServiceId: db.prepare(`
    SELECT * FROM service_variants WHERE service_id = ? AND enabled = 1 ORDER BY display_order ASC, id ASC
  `),
  
  getVariantById: db.prepare(`
    SELECT * FROM service_variants WHERE id = ?
  `),
  
  insertVariant: db.prepare(`
    INSERT INTO service_variants (service_id, name, description, price_modifier, image_path, enabled, display_order)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `),
  
  updateVariant: db.prepare(`
    UPDATE service_variants 
    SET name = ?, description = ?, price_modifier = ?, image_path = ?, enabled = ?, display_order = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `),
  
  deleteVariant: db.prepare(`
    DELETE FROM service_variants WHERE id = ?
  `),

  countVariantsByServiceId: db.prepare(`
    SELECT COUNT(*) as count FROM service_variants WHERE service_id = ?
  `),
};

export default db;

