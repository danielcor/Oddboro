ALTER TABLE "ledger" ADD COLUMN "embedding_model" text;--> statement-breakpoint
-- Written by hand: a row's new vector is not news to the Ledger window, so the
-- re-index after the search model arrives tells the page nothing.
DROP TRIGGER ledger_notify ON ledger;--> statement-breakpoint
CREATE TRIGGER ledger_notify AFTER INSERT OR DELETE OR UPDATE OF kind, actor, title, body, reason, ask_id, task_id, run_id, created_at ON ledger FOR EACH STATEMENT EXECUTE FUNCTION office_notify();
