CREATE TABLE IF NOT EXISTS places (
  id VARCHAR(36) PRIMARY KEY,
  name VARCHAR(255) NOT NULL UNIQUE,
  latitude NUMERIC(9,6) NOT NULL,
  longitude NUMERIC(9,6) NOT NULL
);

CREATE TABLE IF NOT EXISTS sea_legs (
  id VARCHAR(36) PRIMARY KEY,
  "fromPlace" VARCHAR(255) NOT NULL,
  "toPlace" VARCHAR(255) NOT NULL,
  "distanceKm" NUMERIC(10,2) NOT NULL
);

CREATE TABLE IF NOT EXISTS positions (
  id VARCHAR(36) PRIMARY KEY,
  "boatId" VARCHAR(36) NOT NULL,
  latitude NUMERIC(9,6) NOT NULL,
  longitude NUMERIC(9,6) NOT NULL,
  speed NUMERIC(6,2),
  "createdAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_positions_boat ON positions ("boatId", "createdAt" DESC);

INSERT INTO places (id, name, latitude, longitude) VALUES
  (gen_random_uuid()::text, 'Antananarivo', -18.9137, 47.5361),
  (gen_random_uuid()::text, 'Toamasina', -18.1492, 49.4023)
ON CONFLICT (name) DO NOTHING;
