-- Schema PostgreSQL for the Saint-Jude backend.
-- Connect to the target database first, then run:
--   psql "$DATABASE_URL" -f schema-postgresql.sql
-- For a GUI client, open this file and execute it against the selected database.
-- Create the target database before running this file.

CREATE TABLE IF NOT EXISTS "user" (
  id VARCHAR(36) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  "lastName" VARCHAR(255) NOT NULL,
  password VARCHAR(255) NOT NULL,
  email VARCHAR(255) NOT NULL UNIQUE,
  tel VARCHAR(50),
  role VARCHAR(100) NOT NULL,
  permissions JSONB
);

CREATE TABLE IF NOT EXISTS boats (
  id VARCHAR(36) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  capacity INTEGER NOT NULL DEFAULT 0,
  state VARCHAR(50) NOT NULL,
  crew JSONB,
  "userId" VARCHAR(36)
);

CREATE TABLE IF NOT EXISTS trips (
  id VARCHAR(36) PRIMARY KEY,
  "boatId" VARCHAR(36),
  depart VARCHAR(100),
  arrive VARCHAR(100),
  "from" VARCHAR(255),
  "to" VARCHAR(255),
  status VARCHAR(50),
  "userId" VARCHAR(36)
);

CREATE TABLE IF NOT EXISTS reservations (
  id VARCHAR(36) PRIMARY KEY,
  "clientName" VARCHAR(255),
  "clientTel" VARCHAR(50),
  "clientAdresse" VARCHAR(255),
  "destName" VARCHAR(255),
  "destTel" VARCHAR(50),
  "destAdresse" VARCHAR(255),
  status VARCHAR(50),
  date VARCHAR(50),
  quantity INTEGER DEFAULT 0,
  weight NUMERIC(12,2) DEFAULT 0,
  "totalPrice" NUMERIC(14,2) DEFAULT 0,
  "amountPaid" NUMERIC(14,2) DEFAULT 0,
  "amountToPay" NUMERIC(14,2) DEFAULT 0,
  "paymentStatus" BOOLEAN DEFAULT FALSE,
  "tripId" VARCHAR(36),
  "userId" VARCHAR(36),
  "idCashMovement" VARCHAR(36)
);

CREATE TABLE IF NOT EXISTS goods (
  id VARCHAR(36) PRIMARY KEY,
  "itemName" VARCHAR(255),
  types VARCHAR(100),
  "embarkDate" VARCHAR(50),
  quantity INTEGER DEFAULT 0,
  "unitWeight" NUMERIC(12,2) DEFAULT 0,
  "totalWeight" NUMERIC(12,2) DEFAULT 0,
  "unitPrice" NUMERIC(14,2) DEFAULT 0,
  "totalPrice" NUMERIC(14,2) DEFAULT 0,
  "amountToPay" NUMERIC(14,2) DEFAULT 0,
  status BOOLEAN DEFAULT FALSE,
  state VARCHAR(50),
  "reservationId" VARCHAR(36),
  "numberLot" VARCHAR(100),
  "userId" VARCHAR(36),
  "tripId" VARCHAR(36)
);

CREATE TABLE IF NOT EXISTS cashmovements (
  id VARCHAR(36) PRIMARY KEY,
  designation VARCHAR(255),
  credit NUMERIC(14,2) DEFAULT 0,
  debit NUMERIC(14,2) DEFAULT 0,
  "tripId" VARCHAR(36),
  type VARCHAR(10),
  "goodsId" VARCHAR(36),
  "userId" VARCHAR(36),
  date VARCHAR(50)
);

CREATE TABLE IF NOT EXISTS fuelconsumptions (
  id VARCHAR(36) PRIMARY KEY,
  "tripId" VARCHAR(36),
  quantity NUMERIC(12,2) DEFAULT 0,
  "fuelType" VARCHAR(100),
  "fuelPrice" NUMERIC(14,2) DEFAULT 0,
  cost NUMERIC(14,2) DEFAULT 0,
  "userId" VARCHAR(36),
  "remainingFuel" NUMERIC(12,2),
  "createdAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_boats_userid ON boats ("userId");
CREATE INDEX IF NOT EXISTS idx_trips_boatid ON trips ("boatId");
CREATE INDEX IF NOT EXISTS idx_trips_userid ON trips ("userId");
CREATE INDEX IF NOT EXISTS idx_reservations_tripid ON reservations ("tripId");
CREATE INDEX IF NOT EXISTS idx_reservations_userid ON reservations ("userId");
CREATE INDEX IF NOT EXISTS idx_goods_reservationid ON goods ("reservationId");
CREATE INDEX IF NOT EXISTS idx_goods_tripid ON goods ("tripId");
CREATE INDEX IF NOT EXISTS idx_cashmovements_tripid ON cashmovements ("tripId");
CREATE INDEX IF NOT EXISTS idx_cashmovements_goodsid ON cashmovements ("goodsId");
CREATE INDEX IF NOT EXISTS idx_fuelconsumptions_tripid ON fuelconsumptions ("tripId");

-- No demo user is inserted here. Create users through a secure application flow;
-- Never store a plain-text demo password.