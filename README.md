# Offline Dev Vault

یک رجیستری محلی و قابل‌حمل برای توسعهٔ آفلاین پروژه‌های **Next.js، React، TypeScript، Node.js و دیتابیس**. این پروژه Verdaccio را به‌عنوان npm proxy/cache اجرا می‌کند و یک Manager اختصاصی روی آن می‌گذارد تا فهرست پکیج‌ها، بررسی نسخه‌های جدید، پیش‌دریافت وابستگی‌ها و زمان‌بندی خودکار را مدیریت کند. runtimeها با lockfile build می‌شوند و از تصویر رسمی Node در Docker Hub استفاده می‌کنند.

## چه چیزی حل می‌شود؟

- هر پکیج موجود در `config/packages.yaml` بررسی می‌شود.
- به‌صورت پیش‌فرض سه نسخهٔ پایدار آخر (نسخهٔ آخر + دو نسخهٔ قبل) دریافت می‌شوند.
- برای هر نسخه، **تمام dependency tree** با `ignore-scripts` نصب آزمایشی می‌شود تا tarball وابستگی‌ها نیز در Verdaccio ذخیره شود.
- نسخه‌های قدیمی‌تر خودکار حذف نمی‌شوند؛ `keepVersions` حداقل نسخه‌هایی است که هر بار تضمین می‌شوند، نه سقف نگه‌داری.
- داشبورد دکمهٔ «بررسی و دریافت همه»، افزودن/حذف، فعال/غیرفعال‌کردن و گزارش زنده دارد.
- عملیات در حال اجرا از داشبورد یا API واقعاً قابل لغو است؛ process فعال npm terminate می‌شود و ادامهٔ صف متوقف می‌گردد.
- عملیات‌های اجرایی و تغییردهنده قبل از اجرا پنجرهٔ تأیید دارند.
- پنل‌ها جمع‌شونده‌اند و داشبورد به تب‌های نمای کلی، کاتالوگ، عملیات و راهنما تقسیم شده است؛ کاتالوگ دارای جست‌وجو، فیلتر دسته/نوع/فعال‌بودن، صفحه‌بندی، انتخاب گروهی برای فعال/غیرفعال‌سازی و دکمهٔ رفرش کنار هر پکیج است.
- اجرای زمان‌بندی‌شده، strict offline mode، healthcheck، backup و دادهٔ پایدار Docker آماده است.

## معماری

```text
npm / pnpm / yarn ───────► Verdaccio :4873 ───────► npmjs.org (فقط حالت آنلاین)
                                ▲
                                │ prefetch metadata + tarballs
                                │
Browser ───────► Manager :7373 ─┴── packages.yaml + state + scheduler
```

Verdaccio تمام metadata و tarballهای درخواست‌شده را در Docker volume نگه می‌دارد. Manager هنگام Sync فقط خود پکیج اصلی را `pack` نمی‌کند؛ یک نصب ایزوله با cache خالی انجام می‌دهد تا وابستگی‌های انتقالی هم از Verdaccio عبور کنند. lifecycle scriptها در این مرحله اجرا نمی‌شوند.

## پیش‌نیاز

- Docker Desktop با Docker Compose v2
- PowerShell 7 یا Windows PowerShell برای اسکریپت‌های آماده (روی Linux/macOS فرمان‌های Compose پایین کافی است)
- اینترنت فقط برای اولین pull/build و عملیات Sync

## شروع سریع

در PowerShell:

```powershell
Copy-Item .env.example .env
.\scripts\start.ps1
```

یا در هر سیستم دارای Docker:

```bash
cp .env.example .env
docker compose up -d --build
```

آزمون end-to-end آفلاین (پکیج باید قبلاً Sync شده باشد):

```powershell
.\scripts\test-offline.ps1 -Package zod -Version 4.4.1
```

سپس:

- داشبورد مدیریت: <http://localhost:7373>
- رابط Verdaccio: <http://localhost:4873>
- تست سلامت: <http://localhost:7373/api/health>

فهرست اولیه شامل **۳۳۸ مورد یکتا** است: ۲۴۷ مورد استخراج‌شده از پروژه‌های محلی و ۱۵۰ مورد منتخب React، TypeScript، Next.js، PostgreSQL، MongoDB، React Native، Expo و Kotlin که موارد تکراری آن‌ها ادغام شده‌اند. نتیجه ۳۱۷ پکیج npm و ۲۱ artifact از Maven/Kotlin است. نسخه‌های دقیق موجود در lockfileهای پروژه‌ها نیز در `requestedVersions` ثبت شده‌اند. در این نسخه، بررسی نسخه و دریافت آفلاین فقط برای npm پیاده‌سازی شده است؛ موارد Maven/Kotlin صرفاً در کاتالوگ قابل نگه‌داری و گروه‌بندی‌اند و در عملیات Check/Sync با خطای روشن گزارش می‌شوند.

در نصب اولیه، `downloadsEnabled` و تمام scheduleها خاموش‌اند؛ پس بالا آوردن سرویس یا بازکردن داشبورد چیزی دانلود نمی‌کند. دکمهٔ Check فقط metadata نسخه‌ها را می‌خواند و دکمهٔ Sync تنها پس از فعال‌کردن صریح دانلود کار می‌کند.

## افزودن پکیج

### داشبورد

نامی مثل `@tanstack/react-query` وارد کنید. سپس دکمهٔ ↻ همان سطر یا Sync All را بزنید.

### فایل قابل نسخه‌بندی

`config/packages.yaml` را ویرایش کنید:

```yaml
packages:
  - ecosystem: npm
    name: '@tanstack/react-query'
    category: frontend
    keepVersions: 3
    enabled: true
    includePrerelease: false
    sources: [manual]
    requestedVersions: []
```

مقدار `keepVersions` کمتر از 3 پذیرفته نمی‌شود. تغییرات داشبورد نیز در همین فایل نوشته می‌شوند، پس می‌توان آن را در Git commit کرد.

### API

```powershell
Invoke-RestMethod http://localhost:7373/api/packages `
  -Method Post -ContentType application/json `
  -Body '{"name":"@tanstack/react-query","category":"frontend","keepVersions":3}'

# فقط بررسی یک پکیج، بدون دریافت tarball
Invoke-RestMethod http://localhost:7373/api/check `
  -Method Post -ContentType application/json `
  -Body '{"refs":["npm:@tanstack/react-query"]}'

# Sync یک پکیج؛ فقط وقتی downloadsEnabled روشن باشد
Invoke-RestMethod http://localhost:7373/api/sync `
  -Method Post -ContentType application/json `
  -Body '{"refs":["npm:@tanstack/react-query"]}'

# Sync تمام موارد فعال
Invoke-RestMethod http://localhost:7373/api/sync `
  -Method Post -ContentType application/json -Body '{}'
```

هر زمان فقط یک job اجرا می‌شود تا مصرف دیسک و شبکه قابل‌کنترل بماند.

### توقف عملیات

در پنل عملیات جاری دکمهٔ «توقف عملیات» نمایش داده می‌شود. پس از تأیید، درخواست npm فعال ابتدا با `SIGTERM` و در صورت نیاز با `SIGKILL` متوقف می‌شود و job به وضعیت `cancelled` می‌رود. API متناظر:

```powershell
Invoke-RestMethod http://localhost:7373/api/jobs/JOB_ID/cancel `
  -Method Post -ContentType application/json -Body '{}'
```

کنترل‌های نمایشی مانند باز/بسته‌کردن پنل، صفحهٔ بعد/قبل و فیلترها تأیید نمی‌خواهند؛ تمام دکمه‌های شروع عملیات، ذخیره، افزودن، حذف، فعال‌سازی و توقف تأیید می‌خواهند.

### بازتولید کاتالوگ پروژه‌های محلی

این عملیات فقط manifest و lockfileها را می‌خواند و هیچ پکیجی نصب نمی‌کند:

```powershell
node tools/import-project-catalog.mjs "C:\path\to\projects"
```

خروجی مستقل اسکن در `config/catalogs/project-packages.yaml` و فهرست ۱۵۰تایی در `config/catalogs/popular-150.yaml` قرار دارد. نام پوشه‌های منبع در خروجی با شناسه‌های عمومی جایگزین می‌شود. `config/packages.yaml` نسخهٔ ادغام‌شده و قابل‌استفادهٔ برنامه است.

## استفاده در پروژه‌ها

### فقط همان پروژه (پیشنهادی)

در ریشهٔ پروژهٔ مقصد:

```powershell
C:\path\to\offline-dev-vault\scripts\use-registry.ps1 .
```

یا فایل `.npmrc` بسازید:

```ini
registry=http://localhost:4873/
audit=false
fund=false
fetch-retries=1
```

بعد دستورات عادی کار می‌کنند:

```bash
npm install react zod
pnpm add fastify
yarn add typescript
npm create next-app@latest my-app
```

برای pnpm/yarn نیز رجیستری npm از `.npmrc` خوانده می‌شود. اگر تنظیم سراسری می‌خواهید:

```bash
npm config set registry http://localhost:4873/
pnpm config set registry http://localhost:4873/
yarn config set npmRegistryServer http://localhost:4873/
```

بازگرداندن npm به حالت عمومی:

```bash
npm config set registry https://registry.npmjs.org/
```

### ساخت پروژه Next.js بدون اینترنت

تا وقتی آنلاین هستید، در داشبورد `create-next-app`، `next`، `react` و `react-dom` را Sync کنید. سپس حالت آفلاین را فعال و اجرا کنید:

```powershell
.\scripts\offline-mode.ps1
npm create next-app@latest my-offline-app
```

نسخهٔ دقیق همیشه قابل‌اعتمادتر از `latest` است؛ مثلاً `npm create next-app@16.1.0`، مشروط به اینکه همان نسخه قبلاً Sync شده باشد.

## حالت strict offline

وقتی اینترنت قطع است Verdaccio می‌تواند از cache پاسخ دهد، اما برای جلوگیری کامل از تلاش uplink این حالت را فعال کنید:

```powershell
.\scripts\offline-mode.ps1
```

در Linux/macOS:

```bash
docker compose -f compose.yaml -f compose.offline.yaml up -d --force-recreate registry
```

بازگشت به حالت آنلاین:

```powershell
.\scripts\online-mode.ps1
```

> `npm --offline` را با این رجیستری استفاده نکنید؛ آن گزینه شبکهٔ خود npm client را قطع می‌کند و ممکن است حتی اتصال localhost را هم محدود کند. strict offline در سمت Verdaccio اعمال شده است.

### نکته دربارهٔ lockfileهای قدیمی

اگر `package-lock.json` موجود، URL مستقیم `registry.npmjs.org` دارد، npm ممکن است همان URL را دنبال کند. برای پروژه‌ای که قرار است آفلاین باشد، lockfile را یک‌بار در حالت آنلاین و با رجیستری محلی بازسازی کنید. برای lockfileهای جدید می‌توانید این تنظیم را به `.npmrc` بیفزایید:

```ini
omit-lockfile-registry-resolved=true
```

سپس نسخه‌ها از lockfile می‌آیند ولی hostname رجیستری از config جاری انتخاب می‌شود.

## زمان‌بندی و تنظیمات

تنظیمات کاربردی از داشبورد و داخل `config/packages.yaml` مدیریت می‌شوند:

- کلید سراسری اجازهٔ دانلود tarball
- کلید سراسری scheduler
- تعداد پیش‌فرض نسخه‌های stable، از ۳ تا ۲۰
- لیست‌های مستقل با مجموعهٔ انتخابی از پکیج‌ها
- فاصلهٔ اجرای هر لیست از ۱ تا ۳۶۵ روز
- ساعت محلی اجرای هر لیست
- حالت `check` برای بررسی metadata یا `sync` برای بررسی و دریافت

اگر سیستم در ساعت تعیین‌شده خاموش باشد، آن اجرا جبران نمی‌شود و scheduler تا نوبت معتبر بعدی منتظر می‌ماند. این سیاست با `missedRunPolicy: skip` در فایل config ثبت شده است. scheduleهای اولیه خاموش‌اند.

```yaml
settings:
  downloadsEnabled: false
  schedulerEnabled: false
  defaultKeepVersions: 3
  missedRunPolicy: skip
lists:
  - id: weekly-frontend
    name: Frontend weekly check
    packageRefs: [npm:react, npm:next, npm:typescript]
    schedule:
      enabled: true
      everyDays: 7
      time: 03:30
      mode: check
      anchorDate: 2026-08-27
```

تنظیمات زیرساختی در `.env` باقی می‌مانند:

| متغیر | پیش‌فرض | کاربرد |
|---|---:|---|
| `BIND_ADDRESS` | `127.0.0.1` | فقط سیستم محلی؛ برای LAN آگاهانه `0.0.0.0` بگذارید |
| `DEFAULT_KEEP_VERSIONS` | `3` | حداقل نسخه‌های پایدار هر پکیج |
| `NPM_FETCH_TIMEOUT_MS` | `120000` | timeout عملیات npm |
| `TZ` | `Asia/Tehran` | timezone زمان‌بندی |

پس از تغییر `.env`:

```bash
docker compose up -d --build --force-recreate
```

## داده، حجم و پشتیبان‌گیری

دو volume نگه‌داری می‌شوند:

- `offline-dev-vault_registry-storage`: metadata و tarballهای npm
- `offline-dev-vault_manager-data`: وضعیت و ۵۰ job آخر

فهرست پکیج‌ها روی host در `config/packages.yaml` است. پشتیبان‌گیری سازگار (با توقف کوتاه سرویس‌ها):

```powershell
.\scripts\backup.ps1
```

خروجی در `backups/` قرار می‌گیرد و در Git نادیده گرفته می‌شود. cache با گذشت زمان رشد می‌کند؛ این رفتار برای حفظ قابلیت بازگشت عمدی است. پاک‌سازی خودکار نداریم چون حذف نسخه‌ای که یک lockfile قدیمی لازم دارد، با هدف پروژه تضاد دارد.

داشبورد حجم کل registry، حجم هر پکیج و نمودار ده پکیج حجیم‌تر را مستقیماً از volume فقط‌خواندنی Verdaccio اندازه می‌گیرد. بنابراین پکیج‌هایی که در استفادهٔ عادی یک پروژه از proxy عبور کرده‌اند نیز در محاسبه دیده می‌شوند.

## رفتار هوشمند هنگام نصب از پروژه

وقتی `.npmrc` پروژه به `http://localhost:4873/` اشاره کند، npm همیشه ابتدا از Verdaccio درخواست می‌کند:

1. اگر metadata و tarball نسخه در storage محلی باشد، همان نسخه محلی پاسخ داده می‌شود.
2. اگر موجود نباشد و اینترنت/uplink فعال باشد، Verdaccio آن را از npmjs می‌گیرد، هم‌زمان در storage ذخیره می‌کند و به npm تحویل می‌دهد.
3. نصب در پروژه ادامه می‌یابد و درخواست‌های بعدی همان نسخه از cache محلی پاسخ می‌گیرند.
4. در strict offline mode هیچ uplink وجود ندارد و نسخهٔ موجودنباشد با خطا برمی‌گردد؛ هیچ fallback مخفی به اینترنت انجام نمی‌شود.

این رفتار خود proxy registry است و به روشن‌بودن scheduler یا `downloadsEnabled` داشبورد وابسته نیست؛ `downloadsEnabled` فقط jobهای پیش‌دریافت Manager را قفل می‌کند. اگر می‌خواهید پروژه نیز حق دریافت آنلاین نداشته باشد، strict offline mode را فعال کنید.

## امنیت

- پورت‌ها پیش‌فرض فقط روی `127.0.0.1` bind شده‌اند.
- خواندن عمومی روی شبکهٔ bindشده مجاز است، publish نیاز به کاربر Verdaccio دارد.
- Manager هنگام prefetch از `--ignore-scripts` استفاده می‌کند.
- برای قرار دادن روی LAN یا سرور، reverse proxy با TLS و کنترل دسترسی اضافه کنید؛ صرفاً تغییر `BIND_ADDRESS` برای اینترنت عمومی مناسب نیست.
- token رجیستری خصوصی را در Git قرار ندهید. Verdaccio از env token برای uplink پشتیبانی می‌کند و باید از secret management استفاده شود.

## توسعه و انتشار روی Git

```bash
cd manager
npm ci
npm test
cd ..
docker compose config
docker compose up -d --build
```

مواردی که باید commit شوند: کد، Compose، configهای Verdaccio، `package-lock.json` و `config/packages.yaml`. فایل `.env` و داده/backup نباید commit شوند. GitHub Actions تست‌ها و build هر push/PR را انجام می‌دهد و Dependabot به‌صورت هفتگی dependencyها را بررسی می‌کند. پروژه تحت مجوز MIT است.

## محدودیت‌های آگاهانه و مسیر آینده

- این نسخه npm-compatible registry است؛ cache ایمیج Docker، پکیج‌های apt، Python/PyPI و باینری‌های Playwright یک مسئلهٔ جدا هستند. معماری Compose اجازه می‌دهد بعداً سرویس‌هایی مثل registry:2، devpi یا apt-cacher-ng اضافه شوند.
- dependencyهای Kotlin/Android در کاتالوگ ثبت و قابل عضویت در لیست‌اند، اما Verdaccio فقط npm-compatible است و JAR/AARهای Maven را mirror نمی‌کند. برای دانلود آفلاین Kotlin باید backend جداگانهٔ Maven proxy اضافه شود؛ تا آن زمان دکمهٔ Sync برای موارد Maven نمایش داده نمی‌شود.
- optional dependencyهای وابسته به سیستم‌عامل فقط برای platform کانتینر Linux پیش‌دریافت می‌شوند. برای پکیج‌های دارای باینری platform-specific بهتر است نسخهٔ هر platform را جداگانه Sync/آزمایش کنید.
- پکیج‌هایی که نصب واقعی‌شان به lifecycle script و دانلود مستقیم از GitHub/CDN وابسته است ممکن است فقط با npm tarball کامل آفلاین نشوند. Playwright browserها و Prisma engineها نمونه‌های مهم‌اند و باید asset mirror جداگانه برایشان طراحی شود.
- Manager عمداً حذف tarball ندارد. پاک‌سازی باید به‌صورت یک قابلیت صریح، با dry-run و حفاظت از lockfileها افزوده شود.

## عیب‌یابی سریع

```bash
docker compose ps
docker compose logs -f manager
docker compose logs -f registry
curl http://localhost:4873/-/ping
curl http://localhost:7373/api/health
```

اگر Sync خطا داد، متن job در داشبورد و `docker compose logs manager` را ببینید. برای پکیج خصوصی، uplink و token مربوط به همان registry باید به `verdaccio/config.yaml` اضافه شود.

## مبنای تصمیم معماری

Verdaccio طبق مستندات رسمی یک proxy registry با cache اشتراکی metadata و tarball است، Docker image رسمی دارد و با حذف uplink/proxy می‌تواند کاملاً آفلاین اجرا شود. این پروژه لایهٔ prefetch و مدیریت را روی آن اضافه می‌کند؛ قابلیتی که proxy cache به‌تنهایی و پیش از اولین درخواست تضمین نمی‌کند.

- [Verdaccio caching strategies](https://www.verdaccio.org/docs/caching/)
- [Verdaccio Docker guide](https://www.verdaccio.org/docs/docker/)
- [Verdaccio offline registry](https://www.verdaccio.org/docs/linking-remote-registry/)
- [npm config reference](https://docs.npmjs.com/using-npm/config/)
