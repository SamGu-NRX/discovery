-- How many of a candidate's leases expired without a completion. A
-- deferral (complete with state "new") keeps attempts, so attempts also
-- counts deliberate hand-backs; the crash-loop guard counts only these.
ALTER TABLE candidates ADD COLUMN expired_leases INTEGER NOT NULL DEFAULT 0;
