# חיבור TikTok LIVE Studio לשרת WANNA

## 1. מה למלא בחלון "Enter your environment variable" של ה-Studio
| שם | ערך | הסבר |
|---|---|---|
| `BOOSTERA_UPSTREAM_URL` | `http://localhost:8800` | הכתובת של השרת. אם ה-Studio רץ בענן (aistudio.google.com) — הכתובת הציבורית של השרת (https) |
| `BOOSTERA_CLIENT_KEY` | `<CONFIGURE_LOCALLY>` | המפתח בין ה-Studio לשרת (זהה ל-`STUDIO_CLIENT_KEY` ב-`server.env`) |
| `BOOSTERA_API_URL` | `/api/v1` | להשאיר — זה ה-API הפנימי של ה-Studio |
| `BOOSTERA_WS_URL` | ריק | להשאיר ריק |
| `BOOSTERA_ADMIN_KEY` | כל ערך (למשל אותו מפתח) | השרת שלנו לא צריך אותו |
| `ARIEL_SERVER_URL` | אותו ערך כמו `BOOSTERA_UPSTREAM_URL` | שם ישן, לגיבוי |
| `ARIEL_CLIENT_KEY` | אותו ערך כמו `BOOSTERA_CLIENT_KEY` | שם ישן, לגיבוי |
| `ARIEL_ADMIN_KEY` | אותו ערך כמו `BOOSTERA_ADMIN_KEY` | שם ישן, לגיבוי |
| `LIVEKIT_URL` / `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` | ריק | לא בשימוש |
| `DEEPAR_CONFIG` | `disabled` | הזיהוי שלנו הוא MediaPipe, לא DeepAR |
| `GEMINI_API_KEY` | המפתח שלך מ-Google AI Studio (לא חובה) | רק לפיצ'ר המוזיקה של ה-Studio |

## 2. השכבות הנקיות (מקור דפדפן / מצלמה וירטואלית, 1080x1920)
| כתובת | שכבה | מה יש בה |
|---|---|---|
| `http://localhost:8800/clean/background` | **רקע** — מאחורי המצלמה | סרטוני רקע (תומכים), רמיקסים, חדרים |
| *(המצלמה של ה-Studio)* | **מצלמה** | |
| `http://localhost:8800/clean/foreground` | **פרונט** — מעל המצלמה, שקוף | מתנות, אוברליי, קליפי קרב **עם הראש החי של המתחרה** (סנייפ, עגבניות, חיתול, הגמד ×2/×3/×5, רקדנית, תינוק, יד), דפיקות הגמד, דאבל, WAKE UP (+ בום בסאונד) |
| `http://localhost:8800/clean/program?src=phone&streamer=<שם>` | **הכל ביחד** | מצלמה + כל האפקטים (כולל אפקטים על הפנים והרעדת המסך כולו) — בלי כפתורים |

`?sound=1` בסוף כתובת של שכבה = עם סאונד הקליפים.

## 3. API לפי שכבות
- `GET /api/layers` — הקטלוג מחולק: `background` (videos, remixes, rooms) · `foreground` (gifts, overlays, battle, screen) · `live` · `templates`
- `GET /api/stage-events` — זרם (SSE) של מה שמתנגן עכשיו, לכל השכבות
- הפעלה: `POST /api/overlay/play {id}` · `/api/clip/play {id}` · `/api/special {user,set}` · `/api/bg {id|url}` · `/api/screen {type:"hits"|"double"|"wake"|"tomato"|"stop", count, mult, seconds}` · `/api/desk/stop`
- אירועי קרב לאוטומציות: `POST /api/event {type, user, gift, supporter}`
- קישורי הפעלה (GET, לכפתור): `/play/overlay/<id>` · `/play/battle/<id>` · `/play/gift/<id>` · `/play/clip/<id>` · `/play/screen/wake|hits|double|tomato|stop` · `/play/live/<effect>` · `/play/stop` — הרשימה המלאה ב-`/links`
- המטרה בקרב (הראש החי של המתחרה): השכבה `/clean/foreground` מוצאת אותו לבד ממסך הקרב בטלפון. `POST /api/opponent-pick {pick:{fx,fy}}` = לבחור ראש אחר לפי מקומו על מסך הטלפון (`{pick:null}` = אוטומטי: מי שמולי) · `POST /api/opponent-face?enabled=0|1` = כיבוי/הדלקה · `GET /api/opponent-face` = מצב נוכחי · עגבנייה בסגנון הישן: `/play/screen/tomato?style=head`
- `POST /api/opponent-face?tomatoStyle=live|head` — סגנון העגבנייה על המטרה: `live` = נזרקת על הראש החי שלו, `head` = עגבנייה בצורת הראש שלו (נשמר בשרת, כל הדפים הולכים אחריו).
- אפקט לתומך (התומך עצמו בתוך האפקט, מצויר חי בשכבה `/clean/foreground`): `GET /play/battle/fan_burst?user=<שם>&avatar=<כתובת תמונת הפרופיל>&mult=3` · `GET /play/battle/fan_mvp?user=<שם>&avatar=<כתובת>` · או אירוע `POST /api/event { type: "supporter_gift", supporter, avatar, mult }`.
- מבחוץ: כותרת `x-key: <BOOSTERA_CLIENT_KEY>`. מהמחשב הזה (פנייה ל-`localhost` או ל-`127.0.0.1` עם הפורט של השרת, ולא מתוך דף של אתר אחר) — בלי מפתח.
