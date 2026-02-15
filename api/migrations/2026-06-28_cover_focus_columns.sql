-- Add cover_focus_x and cover_focus_y columns to trips table
-- These control the background-position of the cover image in the UI
ALTER TABLE trips ADD COLUMN cover_focus_x INTEGER NOT NULL DEFAULT 50;
ALTER TABLE trips ADD COLUMN cover_focus_y INTEGER NOT NULL DEFAULT 50;
