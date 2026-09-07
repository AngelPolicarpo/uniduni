import { useState } from "react";
import { Bell, Headphones, Info, Palette, User, Wifi } from "lucide-react";
import { SettingsLayout, SettingsSection } from "./SettingsLayout";
import { AccountAboutTab } from "./AccountAboutTab";
import { AccountDevicesTab } from "./AccountDevicesTab";
import { AccountIdentityTab } from "./AccountIdentityTab";
import { AccountNetworkTab } from "./AccountNetworkTab";
import { AccountNotificationsTab } from "./AccountNotificationsTab";
import { useIdentityStore } from "../../store/identityStore";

const TABS = [
  { id: "account", label: "Minha conta", icon: <User size={16} strokeWidth={2} /> },
  { id: "devices", label: "Dispositivos", icon: <Headphones size={16} strokeWidth={2} /> },
  { id: "appearance", label: "Aparência", icon: <Palette size={16} strokeWidth={2} /> },
  { id: "notifications", label: "Notificações", icon: <Bell size={16} strokeWidth={2} /> },
  { id: "network", label: "Rede", icon: <Wifi size={16} strokeWidth={2} /> },
  { id: "about", label: "Sobre & Atualizações", icon: <Info size={16} strokeWidth={2} /> },
];

export interface AccountSettingsProps {
  onClose: () => void;
}

/**
 * 3.1 Configurações de conta — identidade local, dispositivos, aparência,
 * notificações e diagnóstico de rede, independente de comunidade ativa.
 *
 * Cada aba é um componente próprio: esta tela decide qual delas está na
 * frente, e nada mais.
 */
export function AccountSettings({ onClose }: AccountSettingsProps) {
  const [tab, setTab] = useState("account");
  const identity = useIdentityStore((state) => state.identity);

  if (!identity) return null;

  return (
    <SettingsLayout
      title="Configurações"
      items={TABS}
      activeId={tab}
      onSelect={setTab}
      onClose={onClose}
    >
      {tab === "account" && <AccountIdentityTab identity={identity} />}
      {tab === "devices" && <AccountDevicesTab />}

      {tab === "appearance" && (
        <SettingsSection title="Tema">
          {/* §10, 3.1: informativo, sem toggle que não faz nada. */}
          <p className="text-body text-text-primary">
            Tema escuro (único disponível nesta versão)
          </p>
          <p className="text-meta text-text-tertiary">
            A hierarquia visual vem de superfícies por elevação, não de
            sombra — um tema claro exigiria repensar essa escala inteira.
          </p>
        </SettingsSection>
      )}

      {tab === "notifications" && <AccountNotificationsTab />}
      {tab === "network" && <AccountNetworkTab />}
      {tab === "about" && <AccountAboutTab />}
    </SettingsLayout>
  );
}
