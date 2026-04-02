import { randomUUID } from "crypto";

// All 172 champions as of Feb 2026 (Zaahen is the most recent)
const CHAMPION_NAMES = [
  'Aatrox', 'Ahri', 'Akali', 'Akshan', 'Alistar', 'Ambessa', 'Amumu', 'Anivia', 'Annie', 'Aphelios', 'Ashe', 'Aurelion Sol', 'Aurora', 'Azir',
  'Bard', "Bel'Veth", 'Blitzcrank', 'Brand', 'Braum', 'Briar',
  'Caitlyn', 'Camille', 'Cassiopeia', "Cho'Gath", 'Corki',
  'Darius', 'Diana', 'Dr. Mundo', 'Draven',
  'Ekko', 'Elise', 'Evelynn', 'Ezreal',
  'Fiddlesticks', 'Fiora', 'Fizz',
  'Galio', 'Gangplank', 'Garen', 'Gnar', 'Gragas', 'Graves', 'Gwen',
  'Hecarim', 'Heimerdinger', 'Hwei',
  'Illaoi', 'Irelia', 'Ivern',
  'Janna', 'Jarvan IV', 'Jax', 'Jayce', 'Jhin', 'Jinx',
  "K'Sante", "Kai'Sa", 'Kalista', 'Karma', 'Karthus', 'Kassadin', 'Katarina', 'Kayle', 'Kayn', 'Kennen', "Kha'Zix", 'Kindred', 'Kled', "Kog'Maw",
  'LeBlanc', 'Lee Sin', 'Leona', 'Lillia', 'Lissandra', 'Lucian', 'Lulu', 'Lux',
  'Malphite', 'Malzahar', 'Maokai', 'Master Yi', 'Mel', 'Milio', 'Miss Fortune', 'Mordekaiser', 'Morgana',
  'Naafiri', 'Nami', 'Nasus', 'Nautilus', 'Neeko', 'Nidalee', 'Nilah', 'Nocturne', 'Nunu & Willump',
  'Olaf', 'Orianna', 'Ornn',
  'Pantheon', 'Poppy', 'Pyke',
  'Qiyana', 'Quinn',
  'Rakan', 'Rammus', "Rek'Sai", 'Rell', 'Renata Glasc', 'Renekton', 'Rengar', 'Riven', 'Rumble', 'Ryze',
  'Samira', 'Sejuani', 'Senna', 'Seraphine', 'Sett', 'Shaco', 'Shen', 'Shyvana', 'Singed', 'Sion', 'Sivir', 'Skarner', 'Smolder', 'Sona', 'Soraka', 'Swain', 'Sylas', 'Syndra',
  'Tahm Kench', 'Taliyah', 'Talon', 'Taric', 'Teemo', 'Thresh', 'Tristana', 'Trundle', 'Tryndamere', 'Twisted Fate', 'Twitch',
  'Udyr', 'Urgot',
  'Varus', 'Vayne', 'Veigar', "Vel'Koz", 'Vex', 'Vi', 'Viego', 'Viktor', 'Vladimir', 'Volibear',
  'Warwick', 'Wukong',
  'Xayah', 'Xerath', 'Xin Zhao',
  'Yasuo', 'Yone', 'Yorick', 'Yunara', 'Yuumi',
  'Zaahen', 'Zac', 'Zed', 'Zeri', 'Ziggs', 'Zilean', 'Zoe', 'Zyra',
];

export function pickUniqueSessionName(existingNames: Iterable<string>): string {
  const used = new Set(existingNames);
  const available = CHAMPION_NAMES.filter((name) => !used.has(name));
  if (available.length > 0) return available[Math.floor(Math.random() * available.length)];
  return `session-${randomUUID().slice(0, 6)}`;
}
