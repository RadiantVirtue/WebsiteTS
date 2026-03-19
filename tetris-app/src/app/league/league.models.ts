export interface ChampionDamageProfile {
  physical: number;
  magic: number;
  true: number;
}

export interface Champion {
  key: string;
  name: string;
  icon: string;
  adaptiveType: 'PHYSICAL_DAMAGE' | 'MAGIC_DAMAGE';
  roles: string[];
  positions: string[];
  damageProfile?: ChampionDamageProfile;
}

export interface ItemStats {
  armor?: number;
  magicResistance?: number;
  health?: number;
  abilityPower?: number;
  attackDamage?: number;
  movespeed?: number;
  attackSpeed?: number;
  criticalStrikeChance?: number;
  mana?: number;
  abilityHaste?: number;
  lethality?: number;
  magicPenetration?: number;
  healAndShieldPower?: number;
}

export interface BuildItem {
  id: number;
  name: string;
  icon: string;
  goldTotal: number;
  stats: ItemStats;
  simpleDescription: string | null;
  situational: boolean;
  core: boolean;
}

export interface BootsItem extends BuildItem {
  bootsSource: 'matchup' | 'fallback';
}

export interface BuildResult {
  items: BuildItem[];
  boots: BootsItem;
  archetype: string;
}

export interface DamageProfile {
  adPercent: number;
  apPercent: number;
  truePercent: number;
}
