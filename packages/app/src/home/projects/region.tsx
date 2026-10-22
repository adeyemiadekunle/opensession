import type { HomeProjectsController } from "./controller"
import { HomeProjectsView } from "./view"
import type { HomeScrollController } from "../scroll"

export function HomeProjects(props: {
  projects: HomeProjectsController
  // The home page's scroll container; the sidebar list (OpenSession) scrolls on its own.
  scroll?: HomeScrollController
  dropdown?: boolean
  sidebar?: boolean
  // Called after a project or server is picked (the sidebar then shows the home page).
  onPicked?: () => void
}) {
  return (
    <HomeProjectsView
      dropdown={props.dropdown}
      sidebar={props.sidebar}
      language={props.projects.copy.language}
      servers={props.projects.server.list()}
      projects={props.projects.project.list()}
      recentlyClosed={props.projects.project.recentlyClosed()}
      selection={props.projects.selection.value()}
      homedir={props.projects.project.homedir()}
      serverHealth={props.projects.server.health}
      projectsForServer={props.projects.server.projects}
      collapsed={props.projects.server.collapsed}
      canRevealProject={props.projects.project.canReveal}
      hasUnread={props.projects.project.hasUnread}
      onWheel={(event) => props.scroll?.viewport.containWheel(event)}
      onChooseProject={props.projects.project.choose}
      onFocusServer={(server) => {
        props.projects.server.focus(server)
        props.onPicked?.()
      }}
      onAuthenticateServer={props.projects.server.authenticate}
      onToggleCollapsed={props.projects.server.toggleCollapsed}
      onEditServer={props.projects.server.edit}
      canRemoveServer={props.projects.server.canRemove}
      onRemoveServer={props.projects.server.remove}
      canHideServer={props.projects.server.canHide}
      onHideServer={props.projects.server.hide}
      onMoveProject={props.projects.project.move}
      onSelectProject={(server, directory) => {
        props.projects.project.select(server, directory)
        props.onPicked?.()
      }}
      onAddProjects={props.projects.project.add}
      onOpenProjectNewSession={props.projects.project.openNewSession}
      canImportSession={props.projects.project.canImportSession}
      onImportSession={props.projects.project.importSession}
      onEditProject={props.projects.project.edit}
      onRevealProject={props.projects.project.reveal}
      onClearNotifications={props.projects.project.clearNotifications}
      onCloseProject={props.projects.project.close}
      onOpenSettings={props.projects.utility.settings}
      onOpenHelp={props.projects.utility.help}
    />
  )
}
