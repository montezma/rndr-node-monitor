# RNDR Node Monitor

<img width="2682" height="2013" alt="image" src="https://github.com/user-attachments/assets/6e2cd539-b720-48d9-a313-e8502f5557e2" />


<img width="768" height="306" alt="features label for rndr app" src="https://github.com/user-attachments/assets/5bf41b05-86c9-42be-9a03-e4229dcb6283" />


<img width="1920" height="1340" alt="features label for rndr app2" src="https://github.com/user-attachments/assets/33994076-eb37-4d6d-ae61-d16e34b60438" />


A cross-platform monitoring tool for RNDR nodes running on your local network.

## Features

- **Multi-Node Monitoring:** Discover and monitor all RNDR nodes on your local network.
- **Web Interface:** Access a comprehensive web dashboard from any device on your network, including mobile phones.
- **Detailed Statistics:** Track lifetime, daily, and epoch-based frame statistics (successful/failed).
- **GPU Monitoring:** View real-time GPU stats including temperature, utilization, memory usage, and power state.
- **Performance Chart:** Visualizes frame render times for the current epoch, allowing you to spot performance trends and outliers. Includes zoom, pan, and click-to-copy hash functionality.
- **Home Panel:** A unified dashboard view to monitor the status of all connected nodes at a glance, including client status, thermal throttling, and last frame activity.
- **Remote Log Viewer:** Access and view the `rndr_log.txt` file from any machine on the network directly through the main application or the web interface.
- **Epoch Reports:** Generate CSV reports of render data for any completed epoch.
- **Process Status:** See if the RNDR client and watchdog processes are running.
- **Theming:** Switch between light and dark modes.

## Support the Project

* **If you find this tool useful, please consider supporting its development. Donations are appreciated but not required. Enjoy.**

*    **BTC: bc1qpyzffgaw8rxyrk7knsgnh3rzvpzftgyw8emcsl**

*    **ETH: 0x4975117825a2987b0Da16b7cd117b1047866B430**

*    **SOL: D9qScoXoonvxK1tH8z3uLVpGgaYthfDVxPiUtPoC8XMg**


## Requirements

* **Operating System:** Windows 10 / 11 (64-bit)
* **Graphics Card:** An NVIDIA GPU is required for health and status monitoring, as the application utilizes `nvidia-smi`.
* **Rndr Client:** The rndrclient.exe must be ran on your system one time for the application to successfully run as it will parse the log file. Or you can create an empty log file at `C:\Users\yourusername\AppData\Local\OtoyRndrNetwork\rndr_log.txt`

## How to Use

1.  Go to the **[Releases](https://www.google.com/search?q=https://github.com/montezma/rndr-node-monitor/releases)** page of this repository.
2.  Download the latest portable `.exe` file from the "Assets" section.
3.  Run the application. No installation is required.
4.  To ensure the mDNS works, you must restart once. This will ensure the privleges approved for the firewall allow http://render.local:34568 to be reached.

    If you have issue be sure to report them here. I am not a full time developer, so there may be things I will not get to. Feel free to add suggestions or fork.


## Development

To run the project from source, you will need Node.js and npm installed.

1.  **Clone the repository:**

    ```bash
    git clone https://github.com/montezma/rndr-node-monitor.git
    cd rndr-node-monitor
    ```

2.  **Install dependencies:**

    ```bash
    npm install
    ```

3.  **Run the application in development mode:**

    ```bash
    npm start
    ```

4.  **Build a portable executable:**

    ```bash
    npm run build
    ```

    The packaged application will be located in the `dist` folder.

## License

This project is licensed under the MIT License.


## Disclaimer

This project is an unofficial, third-party tool developed by the community. It is not affiliated with, endorsed by, or connected to OTOY or the RNDR Network in any way. The data presented by this application is parsed from local log files and system commands and is provided for informational purposes only. The accuracy of the statistics is not guaranteed. Use this software at your own risk. I assume no liability for any issues, damages, or discrepancies that may arise from its use.
