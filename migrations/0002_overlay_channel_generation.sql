ALTER TABLE overlays ADD COLUMN channel TEXT NOT NULL DEFAULT '';
ALTER TABLE overlays ADD COLUMN link_generation INTEGER NOT NULL DEFAULT 1;
CREATE UNIQUE INDEX overlays_one_main_per_owner ON overlays(owner_id) WHERE name = 'Main';
