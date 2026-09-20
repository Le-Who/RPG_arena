CREATE TABLE agreement_events (
  id uuid PRIMARY KEY,
  agreement_id uuid NOT NULL,
  session_id uuid NOT NULL REFERENCES game_sessions(id) ON DELETE CASCADE,
  turn_number integer NOT NULL CHECK (turn_number > 0),
  version integer NOT NULL CHECK (version > 0),
  previous_revision_id uuid,
  parties jsonb NOT NULL,
  object text NOT NULL,
  consideration text NOT NULL,
  conditions jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('proposed','accepted','fulfilled','cancelled')),
  rules_version integer NOT NULL CHECK (rules_version = 1),
  source jsonb NOT NULL,
  created_at timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX uq_agreement_revision ON agreement_events(agreement_id, version);
--> statement-breakpoint
CREATE INDEX idx_agreement_session_turn ON agreement_events(session_id, turn_number);
--> statement-breakpoint
CREATE FUNCTION chronicle_check_agreement_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE prior agreement_events%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    -- Campaign deletion may cascade; individual revisions cannot be erased or rewritten.
    IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM game_sessions WHERE id = OLD.session_id) THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'IMMUTABLE_AGREEMENT_EVENT';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM game_turns WHERE id = (NEW.source->>'originTurnId')::uuid
    AND session_id = NEW.session_id AND turn_number = NEW.turn_number AND role = 'narrator'
    AND content = NEW.source->>'quote') THEN RAISE EXCEPTION 'AGREEMENT_SOURCE_MISMATCH'; END IF;
  IF NEW.source->>'kind' IS NULL OR NEW.source->>'kind' NOT IN ('current_turn','player_intent')
    OR (NEW.source->>'turnNumber')::integer IS DISTINCT FROM NEW.turn_number
    OR NEW.source->>'textSha256' IS DISTINCT FROM encode(sha256(convert_to(NEW.source->>'quote', 'UTF8')), 'hex')
    THEN RAISE EXCEPTION 'INVALID_AGREEMENT_SOURCE'; END IF;
  SELECT * INTO prior FROM agreement_events WHERE agreement_id = NEW.agreement_id ORDER BY version DESC LIMIT 1;
  IF FOUND THEN
    IF prior.session_id <> NEW.session_id OR prior.turn_number >= NEW.turn_number
      OR NEW.previous_revision_id IS DISTINCT FROM prior.id OR NEW.version <> prior.version + 1
      OR prior.status IN ('fulfilled','cancelled')
      OR (prior.status = 'proposed' AND NEW.status = 'fulfilled')
      OR (prior.status = 'accepted' AND NEW.status = 'proposed')
      OR NEW.source->>'kind' = 'player_intent'
      THEN RAISE EXCEPTION 'INVALID_AGREEMENT_REVISION'; END IF;
  ELSE
    IF NEW.version <> 1 OR NEW.previous_revision_id IS NOT NULL OR NEW.status NOT IN ('proposed','accepted')
      THEN RAISE EXCEPTION 'MISSING_AGREEMENT_HISTORY'; END IF;
  END IF;
  IF NEW.source->>'kind' = 'player_intent' AND NEW.status <> 'proposed' THEN RAISE EXCEPTION 'AGREEMENT_INTENT_NOT_ACCEPTANCE'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER agreement_events_append_only BEFORE INSERT OR UPDATE OR DELETE ON agreement_events
FOR EACH ROW EXECUTE FUNCTION chronicle_check_agreement_event();
