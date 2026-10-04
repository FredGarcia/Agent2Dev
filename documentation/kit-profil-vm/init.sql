-- Extension pour UUID
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Table des cycles 7E (Mémoire Épisodique / Audit)
CREATE TABLE IF NOT EXISTS cycles_7e (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    cycle_number BIGINT NOT NULL,
    rank VARCHAR(10) NOT NULL DEFAULT 'N',
    status VARCHAR(50) NOT NULL,
    state_data JSONB NOT NULL,
    metrics JSONB NOT NULL,
    action_taken JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_cycles_7e_cycle_number ON cycles_7e(cycle_number);
CREATE INDEX idx_cycles_7e_status ON cycles_7e(status);

-- Canal de notification natif Postgres (LISTEN / NOTIFY)
CREATE OR REPLACE FUNCTION notify_7e_transition()
RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('cycle_7e_updated', row_to_json(NEW)::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_notify_7e_transition
AFTER INSERT ON cycles_7e
FOR EACH ROW EXECUTE FUNCTION notify_7e_transition();