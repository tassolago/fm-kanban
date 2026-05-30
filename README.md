# Financial Move Kanban

Internal kanban board for the Financial Move team — dark theme, 10 department tabs, drag-and-drop, card comments, and email notifications.

## Deploy to Railway

1. **Push to GitHub**
   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   git remote add origin https://github.com/YOUR_USER/YOUR_REPO.git
   git push -u origin main
   ```

2. **Create project on Railway**
   - Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub repo
   - Select your repository

3. **Set environment variables** (Railway → Variables tab)
   ```
   GMAIL_USER=your@gmail.com
   GMAIL_APP_PASSWORD=your_app_password
   APP_URL=https://your-app.up.railway.app
   ```
   Generate a Gmail App Password at: https://myaccount.google.com/apppasswords

4. **Add a Volume** (Railway → Add a service → Volume)
   - Mount path: `/app/data`
   - This persists the SQLite database across deployments

5. Railway will build and deploy automatically. The public URL appears in the dashboard.

## Local development

```bash
npm install
# Edit config.js with your Gmail credentials
node server.js
# Open http://localhost:3000
```

## Architecture

- **Backend:** Node.js + Express
- **Database:** SQLite via `better-sqlite3` — entire kanban state stored as a single JSON blob
- **Frontend:** Vanilla JS, polls `/api/state` every 15 seconds for real-time multi-user sync
- **Emails:** Nodemailer via Gmail SMTP — assignment, status change, and comment notifications
