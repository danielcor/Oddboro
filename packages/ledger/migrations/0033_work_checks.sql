-- NOT VALID: each check holds for every write from now on, and skips the rows an
-- office already holds, so a row an older version wrote never stops the upgrade.
ALTER TABLE "asks" ADD CONSTRAINT "asks_open_undecided" CHECK (("asks"."status" = 'open') = ("asks"."decided_at" is null)) NOT VALID;--> statement-breakpoint
ALTER TABLE "follow_ups" ADD CONSTRAINT "follow_ups_ended_together" CHECK (("follow_ups"."outcome" is null) = ("follow_ups"."done_at" is null)) NOT VALID;--> statement-breakpoint
ALTER TABLE "follow_ups" ADD CONSTRAINT "follow_ups_one_unpark" CHECK (num_nonnulls("follow_ups"."unparked_task", "follow_ups"."unparked_at") <= 1) NOT VALID;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_withdrawn_dropped" CHECK (not "tasks"."withdrawn" or "tasks"."status" = 'dropped') NOT VALID;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_one_park" CHECK (num_nonnulls("threads"."resume_at", "threads"."resume_on_task") <= 1) NOT VALID;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_held_has_time" CHECK ("threads"."held_by" is null or "threads"."resume_at" is not null) NOT VALID;