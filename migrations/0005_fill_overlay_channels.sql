UPDATE overlays
SET channel = (SELECT login FROM users WHERE users.id = overlays.owner_id)
WHERE channel = '';
