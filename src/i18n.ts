import type { LanguageCode, DatingIntention, InterestItem } from './types';

export const TRANSLATIONS: Record<
  LanguageCode,
  {
    navDiscover: string;
    navHowItWorks: string;
    navFeatures: string;
    navSafety: string;
    login: string;
    createAccount: string;
    heroHeadline: string;
    heroSubcopy: string;
    ctaStartStory: string;
    ctaExploreHow: string;
    tagline: string;
    adultsOnlyNotice: string;
  }
> = {
  en: {
    navDiscover: 'Discover',
    navHowItWorks: 'How It Works',
    navFeatures: 'Features',
    navSafety: 'Safety',
    login: 'Log In',
    createAccount: 'Create Account',
    heroHeadline: 'Your next great story begins with hello.',
    heroSubcopy:
      'Meet someone unexpected. Share a conversation. Discover connections worth remembering.',
    ctaStartStory: 'Start Your Story',
    ctaExploreHow: 'Explore How It Works',
    tagline: 'Every connection has a story.',
    adultsOnlyNotice: 'Sri Lanka · Adults 18+ Only · English · සිංහල · தமிழ்',
  },
  si: {
    navDiscover: 'සොයාගන්න',
    navHowItWorks: 'ක්‍රියාත්මක වන ආකාරය',
    navFeatures: 'විශේෂාංග',
    navSafety: 'ආරක්ෂාව',
    login: 'පිවිසෙන්න',
    createAccount: 'ගිණුමක් අරඹන්න',
    heroHeadline: 'ඔබේ මීළඟ සුන්දර කතාව ඇරඹෙන්නේ හමුවීමකිනි.',
    heroSubcopy:
      'අනපේක්ෂිත හමුවීමක්. අවංක කතාබහක්. මතකයේ රැඳෙන සබඳතාවක් සොයාගන්න.',
    ctaStartStory: 'ඔබේ කතාව අරඹන්න',
    ctaExploreHow: 'වැඩිදුර දැනගන්න',
    tagline: 'සෑම හමුවීමකටම කතාවක් ඇත.',
    adultsOnlyNotice: 'ශ්‍රී ලංකාව · වයස 18+ වැඩිහිටියන් සඳහා පමණි',
  },
  ta: {
    navDiscover: 'கண்டறிய',
    navHowItWorks: 'எப்படி செயல்படுகிறது',
    navFeatures: 'சிறப்பம்சங்கள்',
    navSafety: 'பாதுகாப்பு',
    login: 'உள்நுழைய',
    createAccount: 'கணக்கைத் தொடங்கு',
    heroHeadline: 'உங்கள் அடுத்த அழகான கதை ஒரு வணக்கத்தில் தொடங்குகிறது.',
    heroSubcopy:
      'எதிர்பாராத ஒருவரை சந்தியுங்கள். உரையாடலைப் பகிர்ந்து கொள்ளுங்கள். நினைவில் நிற்கும் உறவுகளைக் கண்டறியுங்கள்.',
    ctaStartStory: 'உங்கள் கதையைத் தொடங்குங்கள்',
    ctaExploreHow: 'எப்படி என்று பாருங்கள்',
    tagline: 'ஒவ்வொரு உறவுக்கும் ஒரு கதை உண்டு.',
    adultsOnlyNotice: 'இலங்கை · 18+ வயது வந்தவர்களுக்கு மட்டும்',
  },
};

export const INTENTION_LABELS: Record<DatingIntention, string> = {
  long_term_story: 'Long-term story',
  meaningful_dating: 'Meaningful dating',
  new_conversations: 'New conversations',
  friendship_first: 'Friendship first',
};

export function getInterestLabel(item: InterestItem, lang: LanguageCode): string {
  if (lang === 'si') return item.label_si || item.label_en;
  if (lang === 'ta') return item.label_ta || item.label_en;
  return item.label_en;
}

export const EDITORIAL_PORTRAIT_PRESETS = [
  {
    label: 'Galle Fort Courtyard',
    url: '/src/assets/images/editorial_portrait_amaya_1793978349458.jpg',
  },
  {
    label: 'Colombo Studio',
    url: '/src/assets/images/editorial_portrait_kavan_1793978350314.jpg',
  },
  {
    label: 'Kandy Bookshop',
    url: '/src/assets/images/editorial_portrait_dilini_1793978350862.jpg',
  },
  {
    label: 'Mirissa Blue Hour',
    url: '/src/assets/images/editorial_portrait_ehan_1793978352895.jpg',
  },
];
