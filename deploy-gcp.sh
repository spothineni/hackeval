#!/bin/bash
# ─────────────────────────────────────────────────────────────────
# deploy-gcp.sh — Deploy hackathon-evaluator to Google Cloud Run
# Uses Cloud Build (no local Docker required!)
# Account: sbpothineni@gmail.com
# ─────────────────────────────────────────────────────────────────
set -e

# ── Configuration ─────────────────────────────────────────────────
GCP_ACCOUNT="sbpothineni@gmail.com"
PROJECT_ID="${GCP_PROJECT_ID:-project-57e0fc06-1d0f-465d-ac8}"
REGION="${GCP_REGION:-us-central1}"
SERVICE_NAME="hackathon-evaluator"
IMAGE_NAME="gcr.io/${PROJECT_ID}/${SERVICE_NAME}"

# ── Colors ────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

info()    { echo -e "${BLUE}[INFO]${NC} $*"; }
success() { echo -e "${GREEN}[OK]${NC}   $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC} $*"; }
error()   { echo -e "${RED}[ERR]${NC}  $*"; exit 1; }

echo ""
echo -e "${CYAN}╔══════════════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║     Hackathon Evaluator → Google Cloud Run           ║${NC}"
echo -e "${CYAN}║     Using Cloud Build (no local Docker required)     ║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════════════════════╝${NC}"
echo ""

# ── Step 1: Verify gcloud is installed ───────────────────────────
info "Checking gcloud CLI..."
if ! command -v gcloud &>/dev/null; then
  error "gcloud CLI not found. Install from: https://cloud.google.com/sdk/docs/install"
fi
success "gcloud CLI found."

# ── Step 2: Authenticate ──────────────────────────────────────────
info "Checking authentication for ${GCP_ACCOUNT}..."
ACTIVE_ACCOUNT=$(gcloud auth list --filter="status:ACTIVE" --format="value(account)" 2>/dev/null | head -1)

if [ "$ACTIVE_ACCOUNT" != "$GCP_ACCOUNT" ]; then
  warn "Active account is '${ACTIVE_ACCOUNT:-none}'. Switching to ${GCP_ACCOUNT}..."
  gcloud config set account "$GCP_ACCOUNT"
fi
success "Authenticated as: ${GCP_ACCOUNT}"

# ── Step 3: Set Project ───────────────────────────────────────────
info "Setting project to: ${PROJECT_ID}"
gcloud config set project "$PROJECT_ID" --quiet
success "Project: ${PROJECT_ID}"

# ── Step 4: Enable required APIs ─────────────────────────────────
info "Enabling required GCP APIs..."
gcloud services enable \
  run.googleapis.com \
  containerregistry.googleapis.com \
  cloudbuild.googleapis.com \
  secretmanager.googleapis.com \
  --quiet
success "APIs enabled."

# ── Step 5: Handle JWT Secret via Secret Manager ──────────────────
SECRET_NAME="hackathon-jwt-secret"
info "Checking for JWT secret in Secret Manager..."

if ! gcloud secrets describe "$SECRET_NAME" --project="$PROJECT_ID" &>/dev/null; then
  warn "JWT secret not found. Creating a new one..."
  JWT_SECRET=$(openssl rand -base64 48)
  echo -n "$JWT_SECRET" | gcloud secrets create "$SECRET_NAME" \
    --data-file=- \
    --project="$PROJECT_ID" \
    --replication-policy=automatic
  success "JWT secret created in Secret Manager."
else
  success "JWT secret already exists in Secret Manager."
fi

# Allow Cloud Run service account to access the secret
info "Granting Cloud Run access to secrets..."
PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format="value(projectNumber)")
COMPUTE_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"

gcloud secrets add-iam-policy-binding "$SECRET_NAME" \
  --member="serviceAccount:${COMPUTE_SA}" \
  --role="roles/secretmanager.secretAccessor" \
  --project="$PROJECT_ID" \
  --quiet 2>/dev/null || warn "Could not bind secret IAM (may already exist, continuing...)"

# ── Step 6: Grant Cloud Build permission to push to GCR ──────────
info "Granting Cloud Build storage permissions..."
CLOUDBUILD_SA="${PROJECT_NUMBER}@cloudbuild.gserviceaccount.com"
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${CLOUDBUILD_SA}" \
  --role="roles/storage.admin" \
  --quiet 2>/dev/null || warn "IAM binding may already exist, continuing..."

# ── Step 7: Build image using Cloud Build (no local Docker!) ──────
info "Submitting build to Google Cloud Build..."
info "This will take 2-5 minutes while GCP builds your Docker image remotely..."
gcloud builds submit . \
  --tag="${IMAGE_NAME}:latest" \
  --project="$PROJECT_ID" \
  --timeout=600

success "Image built and pushed: ${IMAGE_NAME}:latest"

# ── Step 8: Deploy to Cloud Run ───────────────────────────────────
info "Deploying to Cloud Run (region: ${REGION})..."

gcloud run deploy "$SERVICE_NAME" \
  --image="${IMAGE_NAME}:latest" \
  --region="$REGION" \
  --platform=managed \
  --allow-unauthenticated \
  --port=3000 \
  --memory=512Mi \
  --cpu=1 \
  --min-instances=0 \
  --max-instances=5 \
  --timeout=300 \
  --set-secrets="JWT_SECRET=${SECRET_NAME}:latest,OPENAI_API_KEY=openai-api-key:latest,DATABASE_URL=neon-database-url:latest,SMTP_USER=zoho-smtp-user:latest,SMTP_PASS=zoho-smtp-pass:latest" \
  --set-env-vars="NODE_ENV=production,AWS_REGION=us-east-1,OPENAI_MODEL=gpt-4o" \
  --quiet

# ── Step 9: Print service URL ─────────────────────────────────────
echo ""
SERVICE_URL=$(gcloud run services describe "$SERVICE_NAME" \
  --region="$REGION" \
  --format="value(status.url)" 2>/dev/null || echo "Run: gcloud run services list --region=${REGION}")

echo -e "${GREEN}╔══════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║              ✅ Deployment Successful!               ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "  ${CYAN}Service URL:${NC}  ${SERVICE_URL}"
echo -e "  ${CYAN}Region:${NC}       ${REGION}"
echo -e "  ${CYAN}Project:${NC}      ${PROJECT_ID}"
echo ""
echo -e "  ${YELLOW}Default login:${NC}  admin / admin123"
echo -e "  ${YELLOW}⚠️  Change the admin password immediately after login!${NC}"
echo ""
echo -e "  View logs:  gcloud run services logs read ${SERVICE_NAME} --region=${REGION}"
echo ""
