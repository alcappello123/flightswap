/**
 * FlightSwap PostgreSQL Database Schema
 * Users, Bookings, Matches, Payments, Audit Logs
 */

-- ============================================
-- TABLES
-- ============================================

-- Users Table
CREATE TABLE users (
  id VARCHAR(50) PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  name VARCHAR(255) NOT NULL,
  device_token TEXT,
  is_premium BOOLEAN DEFAULT false,
  stripe_customer_id VARCHAR(255),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_email (email),
  INDEX idx_premium (is_premium)
);

-- Bookings Table (Flight + Seat Selection)
CREATE TABLE bookings (
  id VARCHAR(50) PRIMARY KEY,
  user_id VARCHAR(50) NOT NULL,
  flight_number VARCHAR(50) NOT NULL,
  airline VARCHAR(100),
  departure_time TIMESTAMP,
  desired_seat VARCHAR(10),
  seat_type VARCHAR(20), -- 'window', 'aisle', 'middle'
  status VARCHAR(50) DEFAULT 'active', -- 'active', 'matched', 'completed', 'cancelled'
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_flight (flight_number),
  INDEX idx_status (status),
  INDEX idx_user_id (user_id)
);

-- Matches Table (Real-time Swap Matches)
CREATE TABLE matches (
  id VARCHAR(50) PRIMARY KEY,
  booking_a_id VARCHAR(50) NOT NULL,
  booking_b_id VARCHAR(50) NOT NULL,
  status VARCHAR(50) DEFAULT 'pending', -- 'pending', 'confirmed', 'completed', 'cancelled'
  confirmed_at TIMESTAMP,
  completed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (booking_a_id) REFERENCES bookings(id) ON DELETE CASCADE,
  FOREIGN KEY (booking_b_id) REFERENCES bookings(id) ON DELETE CASCADE,
  INDEX idx_status (status),
  INDEX idx_created (created_at)
);

-- Transactions Table (Stripe Payments)
CREATE TABLE transactions (
  id VARCHAR(50) PRIMARY KEY,
  user_id VARCHAR(50) NOT NULL,
  stripe_charge_id VARCHAR(255),
  amount_cents INTEGER,
  currency VARCHAR(3) DEFAULT 'EUR',
  type VARCHAR(50), -- 'premium_subscription', 'boost_feature', 'affiliate'
  status VARCHAR(50) DEFAULT 'pending', -- 'pending', 'completed', 'failed', 'refunded'
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_user_id (user_id),
  INDEX idx_status (status)
);

-- Push Notifications Log
CREATE TABLE notifications (
  id VARCHAR(50) PRIMARY KEY,
  user_id VARCHAR(50) NOT NULL,
  title VARCHAR(255),
  body TEXT,
  type VARCHAR(50), -- 'match_found', 'payment_received', 'system'
  read BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_user_id (user_id),
  INDEX idx_created (created_at)
);

-- Audit Logs (GDPR Compliance)
CREATE TABLE audit_logs (
  id VARCHAR(50) PRIMARY KEY,
  user_id VARCHAR(50),
  action VARCHAR(100),
  resource VARCHAR(100),
  old_value TEXT,
  new_value TEXT,
  ip_address VARCHAR(50),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_user_id (user_id),
  INDEX idx_action (action)
);

-- Partners/Services Table (SV Cappello + Affiliates)
CREATE TABLE partners (
  id VARCHAR(50) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  type VARCHAR(50), -- 'service', 'affiliate', 'sponsor'
  description TEXT,
  website_url VARCHAR(255),
  icon_url VARCHAR(255),
  priority INTEGER DEFAULT 1,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Ad Impressions Log (Google AdMob Analytics)
CREATE TABLE ad_impressions (
  id VARCHAR(50) PRIMARY KEY,
  user_id VARCHAR(50),
  ad_type VARCHAR(50), -- 'banner', 'interstitial', 'reward'
  revenue_cents INTEGER,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_user_id (user_id),
  INDEX idx_created (created_at)
);

-- ============================================
-- VIEWS
-- ============================================

-- Daily Stats View
CREATE VIEW daily_stats AS
SELECT 
  DATE(m.created_at) as date,
  COUNT(*) as total_matches,
  COUNT(CASE WHEN m.status = 'confirmed' THEN 1 END) as successful_swaps,
  COUNT(DISTINCT m.booking_a_id) as users_matched,
  COUNT(DISTINCT b1.flight_number) as flights_active
FROM matches m
LEFT JOIN bookings b1 ON m.booking_a_id = b1.id
GROUP BY DATE(m.created_at);

-- User Stats View
CREATE VIEW user_stats AS
SELECT 
  u.id,
  u.email,
  u.name,
  u.is_premium,
  COUNT(DISTINCT b.id) as total_bookings,
  COUNT(DISTINCT CASE WHEN m.status = 'confirmed' THEN m.id END) as successful_swaps,
  SUM(CASE WHEN t.type = 'premium_subscription' THEN t.amount_cents ELSE 0 END) / 100.0 as total_spent_eur,
  MAX(b.created_at) as last_flight_date
FROM users u
LEFT JOIN bookings b ON u.id = b.user_id
LEFT JOIN matches m ON (b.id = m.booking_a_id OR b.id = m.booking_b_id)
LEFT JOIN transactions t ON u.id = t.user_id AND t.status = 'completed'
GROUP BY u.id;

-- ============================================
-- INDEXES
-- ============================================

CREATE INDEX idx_bookings_flight_status ON bookings(flight_number, status);
CREATE INDEX idx_matches_status_created ON matches(status, created_at);
CREATE INDEX idx_transactions_user_status ON transactions(user_id, status);
CREATE INDEX idx_notifications_user_read ON notifications(user_id, read);

-- ============================================
-- INITIAL DATA (SV Cappello Partner)
-- ============================================

INSERT INTO partners (id, name, type, description, website_url, icon_url, priority, active)
VALUES (
  'partner_sv_cappello',
  'SV Cappello',
  'service',
  'Professional Insurance & Accident Reports',
  'https://www.sv-cappello.de',
  'https://www.sv-cappello.de/logo.png',
  1,
  true
);

-- ============================================
-- FUNCTIONS
-- ============================================

-- Cleanup expired records
CREATE OR REPLACE FUNCTION cleanup_old_data()
RETURNS void AS $$
BEGIN
  -- Delete old notifications (older than 90 days)
  DELETE FROM notifications WHERE created_at < NOW() - INTERVAL '90 days';
  
  -- Delete old audit logs (older than 1 year)
  DELETE FROM audit_logs WHERE created_at < NOW() - INTERVAL '1 year';
  
  -- Delete cancelled bookings (older than 30 days)
  DELETE FROM bookings WHERE status = 'cancelled' AND updated_at < NOW() - INTERVAL '30 days';
  
  RAISE NOTICE 'Cleanup completed at %', NOW();
END;
$$ LANGUAGE plpgsql;

-- Update timestamp trigger
CREATE OR REPLACE FUNCTION update_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create triggers for timestamp updates
CREATE TRIGGER users_timestamp BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION update_timestamp();
CREATE TRIGGER bookings_timestamp BEFORE UPDATE ON bookings FOR EACH ROW EXECUTE FUNCTION update_timestamp();
CREATE TRIGGER matches_timestamp BEFORE UPDATE ON matches FOR EACH ROW EXECUTE FUNCTION update_timestamp();

-- ============================================
-- TEST DATA (for development only - DELETE BEFORE PRODUCTION)
-- ============================================

-- Test user
INSERT INTO users (id, email, name, device_token, is_premium)
VALUES (
  'user_test_001',
  'test@flightswap.de',
  'Test User',
  'mock_device_token_12345',
  false
);

-- Test booking
INSERT INTO bookings (id, user_id, flight_number, airline, desired_seat, seat_type, status)
VALUES (
  'booking_test_001',
  'user_test_001',
  'LH456',
  'Lufthansa',
  '14A',
  'window',
  'active'
);
