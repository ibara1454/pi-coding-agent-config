# Pi customization

This context defines the customization units shared across this repository's Pi packages.

## Language

**Package** (Pi package):
A distribution unit containing extensions, skills, prompt templates, themes, or a combination of these resources. A package and the resources it contains are distinct; a package need not contain an extension.
_Avoid_: extension (for the distribution unit), plugin

**Extension**:
A module loaded into the Pi process to extend its behavior, such as by registering tools, commands, event handlers, providers, or terminal UI. An extension can be distributed in a package or loaded on its own.
_Avoid_: package (for the executable resource), plugin
