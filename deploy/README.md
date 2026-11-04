# Deploy na Ubuntu

```bash
sudo git clone <repo-url> /opt/player-props-app
sudo chown -R www-data:www-data /opt/player-props-app

sudo cp /opt/player-props-app/deploy/player-props.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now player-props

sudo apt install -y nginx
sudo cp /opt/player-props-app/deploy/nginx-player-props.conf /etc/nginx/sites-available/player-props
# server_name je već podešen na playerprops.merkurxtip.app
sudo ln -s /etc/nginx/sites-available/player-props /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

sudo ufw allow 'Nginx Full'
```

Logovi: `journalctl -u player-props -f`. Pokreći samo jednu instancu (movement snapshot je u memoriji).

HTTPS (posle što DNS A zapis za playerprops.merkurxtip.app pokazuje na server):

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d playerprops.merkurxtip.app
```
