-- Schéma MySQL pour le projet Saint-Jude
-- À exécuter une fois pour créer la base et les tables :
--   mysql -u root -p < schema.sql

CREATE DATABASE IF NOT EXISTS saint_jude CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE saint_jude;

-- ENTITY: User (table nommée `user`, cf. TABLE_DATA_BASE.USER dans type.ts)
CREATE TABLE IF NOT EXISTS `user` (
  id VARCHAR(36) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  lastName VARCHAR(255) NOT NULL,
  password VARCHAR(255) NOT NULL,
  email VARCHAR(255) NOT NULL UNIQUE,
  tel VARCHAR(50),
  role VARCHAR(100) NOT NULL,
  permissions JSON NULL
);

-- ENTITY: Boat
CREATE TABLE IF NOT EXISTS boats (
  id VARCHAR(36) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  capacity INT NOT NULL DEFAULT 0,
  state VARCHAR(50) NOT NULL,
  crew JSON NULL,
  userId VARCHAR(36),
  INDEX idx_boats_userId (userId)
);

-- ENTITY: Trip
CREATE TABLE IF NOT EXISTS trips (
  id VARCHAR(36) PRIMARY KEY,
  boatId VARCHAR(36),
  depart VARCHAR(100),
  arrive VARCHAR(100),
  `from` VARCHAR(255),
  `to` VARCHAR(255),
  status VARCHAR(50),
  userId VARCHAR(36),
  INDEX idx_trips_boatId (boatId),
  INDEX idx_trips_userId (userId)
);

-- ENTITY: Reservation
CREATE TABLE IF NOT EXISTS reservations (
  id VARCHAR(36) PRIMARY KEY,
  clientName VARCHAR(255),
  clientTel VARCHAR(50),
  clientAdresse VARCHAR(255),
  destName VARCHAR(255),
  destTel VARCHAR(50),
  destAdresse VARCHAR(255),
  status VARCHAR(50),
  date VARCHAR(50),
  quantity INT DEFAULT 0,
  weight DECIMAL(12,2) DEFAULT 0,
  totalPrice DECIMAL(14,2) DEFAULT 0,
  amountPaid DECIMAL(14,2) DEFAULT 0,
  amountToPay DECIMAL(14,2) DEFAULT 0,
  paymentStatus TINYINT(1) DEFAULT 0,
  tripId VARCHAR(36),
  userId VARCHAR(36),
  idCashMovement VARCHAR(36),
  INDEX idx_reservations_tripId (tripId),
  INDEX idx_reservations_userId (userId)
);

-- ENTITY: Goods
CREATE TABLE IF NOT EXISTS goods (
  id VARCHAR(36) PRIMARY KEY,
  itemName VARCHAR(255),
  types VARCHAR(100),
  embarkDate VARCHAR(50),
  quantity INT DEFAULT 0,
  unitWeight DECIMAL(12,2) DEFAULT 0,
  totalWeight DECIMAL(12,2) DEFAULT 0,
  unitPrice DECIMAL(14,2) DEFAULT 0,
  totalPrice DECIMAL(14,2) DEFAULT 0,
  amountToPay DECIMAL(14,2) DEFAULT 0,
  status TINYINT(1) DEFAULT 0,
  state VARCHAR(50),
  reservationId VARCHAR(36),
  numberLot VARCHAR(100),
  userId VARCHAR(36),
  tripId VARCHAR(36),
  INDEX idx_goods_reservationId (reservationId),
  INDEX idx_goods_tripId (tripId)
);

-- ENTITY: CashMovement
CREATE TABLE IF NOT EXISTS cashmovements (
  id VARCHAR(36) PRIMARY KEY,
  designation VARCHAR(255),
  credit DECIMAL(14,2) DEFAULT 0,
  debit DECIMAL(14,2) DEFAULT 0,
  tripId VARCHAR(36),
  type VARCHAR(10),
  goodsId VARCHAR(36),
  userId VARCHAR(36),
  date VARCHAR(50),
  INDEX idx_cashmovements_tripId (tripId),
  INDEX idx_cashmovements_goodsId (goodsId)
);

-- ENTITY: FuelConsumption
CREATE TABLE IF NOT EXISTS fuelconsumptions (
  id VARCHAR(36) PRIMARY KEY,
  tripId VARCHAR(36),
  quantity DECIMAL(12,2) DEFAULT 0,
  fuelType VARCHAR(100),
  fuelPrice DECIMAL(14,2) DEFAULT 0,
  cost DECIMAL(14,2) DEFAULT 0,
  userId VARCHAR(36),
  remainingFuel DECIMAL(12,2) NULL,
  createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_fuelconsumptions_tripId (tripId)
);

-- Remarque : pas de contraintes FOREIGN KEY volontairement (plusieurs tables se
-- référencent mutuellement : reservations -> cashmovements -> goods -> reservations).
-- Les colonnes d'identifiants sont indexées pour la performance, la cohérence
-- est gérée côté application comme c'est déjà le cas dans le frontend.

-- Utilisateur de départ pour pouvoir se connecter à l'application dès le premier lancement
INSERT IGNORE INTO `user` (id, name, lastName, password, email, tel, role)
VALUES ('u1', 'Jean', 'Paul', 'abcdef', 'jean@example.com', '0347654321', 'Propriétaire');
